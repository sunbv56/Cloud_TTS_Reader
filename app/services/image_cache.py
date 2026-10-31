"""Bounded in-memory caches for image manifests and small images.

Every storage read is a billed Class B transaction on B2 (shared daily cap),
and Home asks for the same manifests/covers on every visit. One Fly machine
serves all requests, so a process-local LRU stays coherent as long as every
route that writes or deletes these objects updates it.
"""
import hashlib
import threading
from collections import OrderedDict
from typing import Optional, Tuple

MANIFEST_CACHE_MAX_BYTES = 1 * 1024 * 1024
IMAGE_CACHE_MAX_BYTES = 4 * 1024 * 1024
IMAGE_CACHE_MAX_ITEM_BYTES = 200 * 1024

# A manifest that does not exist is cached as this marker so books flagged
# has_images without a manifest do not hit storage on every visit.
MISSING = b""


def make_etag(data: bytes, found: bool = True) -> str:
    if not found:
        return '"missing"'
    return '"' + hashlib.blake2b(data, digest_size=12).hexdigest() + '"'


def etag_matches(if_none_match: Optional[str], etag: str) -> bool:
    if not if_none_match:
        return False
    candidates = [value.strip() for value in if_none_match.split(",")]
    return "*" in candidates or etag in candidates or f"W/{etag}" in candidates


class _ByteLRU:
    def __init__(self, max_bytes: int, max_item_bytes: int):
        self.max_bytes = max_bytes
        self.max_item_bytes = max_item_bytes
        self._items: "OrderedDict[tuple, Tuple[bytes, str]]" = OrderedDict()
        self._size = 0
        self._writes = 0
        self._lock = threading.Lock()

    @property
    def writes(self) -> int:
        """Bumped by every write/invalidation; read-fills taken before it are dropped."""
        return self._writes

    def get(self, key: tuple) -> Optional[Tuple[bytes, str]]:
        with self._lock:
            item = self._items.get(key)
            if item is not None:
                self._items.move_to_end(key)
            return item

    def put(self, key: tuple, data: bytes, found: bool = True) -> str:
        """Store what a write route just saved to storage."""
        with self._lock:
            self._writes += 1
        return self._store(key, data, found, None)

    def fill(self, key: tuple, data: bytes, found: bool, since: int) -> str:
        """Store what a read just fetched, unless a write landed meanwhile."""
        return self._store(key, data, found, since)

    def _store(self, key: tuple, data: bytes, found: bool, since: Optional[int]) -> str:
        etag = make_etag(data, found)
        with self._lock:
            if since is not None and since != self._writes:
                return etag
            self._discard(key)
            if len(data) <= self.max_item_bytes:
                self._items[key] = (data, etag)
                self._size += len(data)
                while self._size > self.max_bytes and self._items:
                    _, (old, _) = self._items.popitem(last=False)
                    self._size -= len(old)
        return etag

    def pop(self, key: tuple) -> None:
        with self._lock:
            self._writes += 1
            self._discard(key)

    def pop_prefix(self, prefix: tuple) -> None:
        with self._lock:
            self._writes += 1
            for key in [k for k in self._items if k[:len(prefix)] == prefix]:
                self._discard(key)

    def clear(self) -> None:
        with self._lock:
            self._writes += 1
            self._items.clear()
            self._size = 0

    @property
    def size(self) -> int:
        return self._size

    def _discard(self, key: tuple) -> None:
        old = self._items.pop(key, None)
        if old is not None:
            self._size -= len(old[0])


manifest_cache = _ByteLRU(MANIFEST_CACHE_MAX_BYTES, 100 * 1024)
image_cache = _ByteLRU(IMAGE_CACHE_MAX_BYTES, IMAGE_CACHE_MAX_ITEM_BYTES)


def forget_story(user_id: str, story_id: str) -> None:
    manifest_cache.pop((user_id, story_id))
    image_cache.pop_prefix((user_id, story_id))


def clear_all() -> None:
    manifest_cache.clear()
    image_cache.clear()
