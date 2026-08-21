import os
import json
import time
import uuid
import hashlib
import asyncio
import logging
import tempfile
import threading
from collections import OrderedDict
from fastapi import UploadFile

from app.core.config import (
    STORAGE_IO_CONCURRENCY,
    FIRESTORE_IO_CONCURRENCY,
    MAX_IMPORT_CONCURRENCY,
    LEGACY_SOURCE_CACHE_MAX_FILES,
    LEGACY_SOURCE_CACHE_MAX_BYTES,
)
from app.core.security import set_import_semaphore

logger = logging.getLogger("cloud_tts_reader")

# Concurrency Semaphores
_import_semaphore = asyncio.Semaphore(MAX_IMPORT_CONCURRENCY)
set_import_semaphore(_import_semaphore)

_storage_io_semaphore = asyncio.Semaphore(STORAGE_IO_CONCURRENCY)
_firestore_io_semaphore = asyncio.Semaphore(FIRESTORE_IO_CONCURRENCY)

# Legacy source disk cache
_legacy_source_cache = OrderedDict()
_legacy_source_cache_locks = {}
_legacy_source_cache_guard = threading.RLock()


async def _run_blocking(label: str, operation, *args, request_id: str = "", **kwargs):
    """Run SDK calls outside the event loop and emit bounded timing telemetry."""
    started = time.perf_counter()
    try:
        return await asyncio.to_thread(operation, *args, **kwargs)
    except Exception as exc:
        from app.core.database import is_storage_not_found
        if is_storage_not_found(exc) or isinstance(exc, FileNotFoundError):
            logger.debug("storage_not_found label=%s request_id=%s", label, request_id or "-")
        else:
            logger.exception("operation_failed label=%s request_id=%s", label, request_id or "-")
        raise
    finally:
        elapsed_ms = (time.perf_counter() - started) * 1000
        logger.info("operation_timing label=%s request_id=%s elapsed_ms=%.1f", label, request_id or "-", elapsed_ms)


async def _run_storage(label: str, operation, *args, request_id: str = "", **kwargs):
    """Bound Storage SDK calls so slow objects cannot exhaust the 256 MB VM."""
    async with _storage_io_semaphore:
        return await _run_blocking(label, operation, *args, request_id=request_id, **kwargs)


async def _run_firestore(label: str, operation, *args, request_id: str = "", **kwargs):
    """Bound Firestore SDK calls, which are synchronous in the Admin SDK."""
    async with _firestore_io_semaphore:
        return await _run_blocking(label, operation, *args, request_id=request_id, **kwargs)


def _legacy_source_cache_key(user_id: str, filename: str) -> str:
    return f"{user_id}\0{filename}"


def _legacy_source_cache_lock(key: str):
    with _legacy_source_cache_guard:
        return _legacy_source_cache_locks.setdefault(key, threading.Lock())


def _legacy_source_cache_path(key: str) -> str:
    cache_dir = os.path.join(tempfile.gettempdir(), "cloud-tts-reader-source-cache")
    os.makedirs(cache_dir, exist_ok=True)
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    return os.path.join(cache_dir, f"{digest}.txt")


def _get_or_download_legacy_source(download, user_id: str, filename: str):
    """Download a legacy TXT once per process and reuse it for chapter reads."""
    key = _legacy_source_cache_key(user_id, filename)
    target = _legacy_source_cache_path(key)
    with _legacy_source_cache_lock(key):
        with _legacy_source_cache_guard:
            entry = _legacy_source_cache.get(key)
            if entry and os.path.exists(entry[0]):
                _legacy_source_cache.move_to_end(key)
                return entry[0], True

        temporary = f"{target}.{uuid.uuid4().hex}.tmp"
        try:
            download(temporary)
            size = os.path.getsize(temporary)
            if size > LEGACY_SOURCE_CACHE_MAX_BYTES:
                return temporary, False
            os.replace(temporary, target)
        except Exception:
            if os.path.exists(temporary):
                os.remove(temporary)
            raise

        evicted = []
        with _legacy_source_cache_guard:
            previous = _legacy_source_cache.pop(key, None)
            if previous and previous[0] != target:
                evicted.append(previous[0])
            _legacy_source_cache[key] = (target, size)
            while (
                len(_legacy_source_cache) > LEGACY_SOURCE_CACHE_MAX_FILES
                or sum(item[1] for item in _legacy_source_cache.values()) > LEGACY_SOURCE_CACHE_MAX_BYTES
            ):
                old_key, (old_path, _) = _legacy_source_cache.popitem(last=False)
                if old_key != key:
                    evicted.append(old_path)
        for path in evicted:
            if os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    logger.warning("legacy_source_cache_eviction_failed path=%s", path)
        return target, True


def _invalidate_legacy_source_cache(user_id: str, filename: str):
    key = _legacy_source_cache_key(user_id, filename)
    with _legacy_source_cache_guard:
        entry = _legacy_source_cache.pop(key, None)
    if entry and os.path.exists(entry[0]):
        try:
            os.remove(entry[0])
        except OSError:
            logger.warning("legacy_source_cache_invalidation_failed filename=%s", filename)


def _iter_temp_file(file_path: str, chunk_size: int = 1024 * 1024):
    """Stream a temporary file and always remove it after the response."""
    try:
        with open(file_path, "rb") as source:
            while chunk := source.read(chunk_size):
                yield chunk
    finally:
        if os.path.exists(file_path):
            try:
                os.remove(file_path)
            except OSError:
                logger.warning("temporary_response_cleanup_failed path=%s", file_path)


async def _save_upload_with_limit(upload: UploadFile, target_path: str, max_bytes: int):
    """Stream an upload to disk and reject it before it can exhaust memory/disk."""
    total = 0
    try:
        with open(target_path, "wb") as target:
            while chunk := await upload.read(1024 * 1024):
                total += len(chunk)
                if total > max_bytes:
                    raise ValueError(f"File exceeds the {max_bytes} byte limit")
                target.write(chunk)
    except ValueError:
        if os.path.exists(target_path):
            os.remove(target_path)
        raise
    return total


def _load_json_file(file_path: str):
    """Load JSON from disk so the storage response body is never duplicated."""
    with open(file_path, "r", encoding="utf-8") as source:
        return json.load(source)


def _upload_json_blob(blob, payload, content_type: str = "application/json"):
    """Serialize JSON to disk before upload to avoid a string+bytes double copy."""
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".json")
    tmp_path = tmp.name
    tmp.close()
    try:
        with open(tmp_path, "w", encoding="utf-8") as target:
            json.dump(payload, target, ensure_ascii=False, separators=(",", ":"))
        return blob.upload_from_filename(tmp_path, content_type=content_type)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
