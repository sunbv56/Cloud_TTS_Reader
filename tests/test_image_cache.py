"""Image/manifest read caching: batch covers endpoint, ETag/304 and invalidation.

Every storage read is a billed B2 Class B call, so these tests count reads on
the mock backend as well as checking responses.
"""
import json

import pytest
from fastapi.testclient import TestClient

from app.core import database, security
from app.server import create_app
from app.services import image_cache as image_cache_mod
from tests.test_frontend_backend_integration import TEST_UID, _MockBlob, _MockFirestore, _MockStorageBackend

AUTH = {"Authorization": "Bearer mock_valid_token"}
WEBP = b"RIFF\x1a\x00\x00\x00WEBPVP8 " + b"\x00" * 16


class _CountingBlob(_MockBlob):
    def __init__(self, path, store, reads):
        super().__init__(path, store)
        self._reads = reads

    def download_as_bytes(self):
        self._reads.append(("GET", self.path))
        return super().download_as_bytes()

    def download_as_text(self):
        self._reads.append(("GET", self.path))
        return super().download_as_text()

    def exists(self):
        self._reads.append(("HEAD", self.path))
        return super().exists()


class _CountingStorage(_MockStorageBackend):
    def __init__(self):
        super().__init__()
        self.reads = []

    def blob(self, path):
        return _CountingBlob(path, self._files, self.reads)


@pytest.fixture
def storage(monkeypatch):
    monkeypatch.setattr(security, "firebase_admin_initialized", True)
    monkeypatch.setattr(database, "firebase_admin_initialized", True)
    monkeypatch.setattr(security.auth, "verify_id_token", lambda token, clock_skew_seconds=10: {"uid": TEST_UID})
    backend = _CountingStorage()
    import app.routers.books as books_mod
    monkeypatch.setattr(database, "storage", backend)
    monkeypatch.setattr(books_mod, "storage", backend)
    monkeypatch.setattr(books_mod, "db_admin", _MockFirestore())
    image_cache_mod.clear_all()
    yield backend
    image_cache_mod.clear_all()


@pytest.fixture
def client(storage):
    with TestClient(create_app()) as c:
        yield c


def _manifest_path(story_id):
    return f"users/{TEST_UID}/stories/{story_id}/images_manifest.json"


def _seed(storage, story_id, image_id="img_cover_0001", updated_at="2026-01-01T00:00:00Z"):
    manifest = {"version": 1, "coverId": image_id,
                "images": [{"id": image_id, "createdAt": updated_at, "coverCrop": {"x": 0, "y": 0, "width": 1, "height": 1}}]}
    storage._files[_manifest_path(story_id)] = json.dumps(manifest).encode()
    storage._files[f"users/{TEST_UID}/images/{story_id}/{image_id}"] = WEBP
    return manifest


def _covers(client, book_ids, etags=None):
    res = client.post(f"/api/stories/{TEST_UID}/covers", json={"bookIds": book_ids, "etags": etags or {}}, headers=AUTH)
    assert res.status_code == 200, res.text
    return res.json()["books"]


def test_covers_batch_returns_manifests_and_cover_urls(client, storage):
    _seed(storage, "book_a")
    _seed(storage, "book_b", image_id="img_cover_0002")
    books = _covers(client, ["book_a", "book_b", "book_none"])

    assert books["book_a"]["found"] is True
    assert books["book_a"]["manifest"]["coverId"] == "img_cover_0001"
    cover = books["book_a"]["cover"]
    assert cover["id"] == "img_cover_0001"
    assert cover["url"].startswith(f"/api/stories/{TEST_UID}/book_a/images/img_cover_0001?v=")
    assert cover["crop"] == {"x": 0, "y": 0, "width": 1, "height": 1}
    assert books["book_b"]["cover"]["id"] == "img_cover_0002"
    assert books["book_none"] == {"found": False, "etag": books["book_none"]["etag"], "cover": None,
                                  "manifest": {"version": 1, "coverId": None, "images": []}}
    # One GET per manifest and no HEAD-then-GET.
    assert sorted(storage.reads) == sorted(("GET", _manifest_path(b)) for b in ["book_a", "book_b", "book_none"])


def test_covers_batch_is_served_from_memory_and_honours_known_etags(client, storage):
    _seed(storage, "book_a")
    first = _covers(client, ["book_a", "book_none"])
    storage.reads.clear()

    again = _covers(client, ["book_a", "book_none"], {"book_a": first["book_a"]["etag"]})
    assert storage.reads == []
    assert again["book_a"]["notModified"] is True
    assert "manifest" not in again["book_a"]
    assert again["book_a"]["cover"]["id"] == "img_cover_0001"
    assert again["book_none"]["found"] is False


def test_covers_batch_rejects_bad_input_and_other_users(client, storage):
    url = f"/api/stories/{TEST_UID}/covers"
    assert client.post(url, json={"bookIds": "x"}, headers=AUTH).status_code == 400
    assert client.post(url, json={"bookIds": ["../x/y"]}, headers=AUTH).status_code == 400
    assert client.post(url, json={"bookIds": [f"b{i}" for i in range(101)]}, headers=AUTH).status_code == 413
    assert client.post("/api/stories/someone_else/covers", json={"bookIds": ["a"]}, headers=AUTH).status_code == 403
    assert client.post(url, json={"bookIds": ["a"]}).status_code == 401
    assert storage.reads == []


def test_corrupted_manifest_is_reported_and_not_cached(client, storage):
    storage._files[_manifest_path("book_bad")] = b"{not json"
    books = _covers(client, ["book_bad"])
    assert books["book_bad"]["retryable"] is False
    res = client.get(f"/api/stories/{TEST_UID}/book_bad/images/manifest", headers=AUTH)
    assert res.status_code == 502
    assert len(storage.reads) == 2


def test_manifest_get_sends_etag_and_304(client, storage):
    _seed(storage, "book_a")
    url = f"/api/stories/{TEST_UID}/book_a/images/manifest"
    res = client.get(url, headers=AUTH)
    assert res.status_code == 200
    assert res.headers["X-Manifest-Found"] == "true"
    assert "private" in res.headers["Cache-Control"]
    etag = res.headers["ETag"]
    assert res.json()["_found"] is True

    storage.reads.clear()
    not_modified = client.get(url, headers={**AUTH, "If-None-Match": etag})
    assert not_modified.status_code == 304
    assert not_modified.headers["ETag"] == etag
    assert storage.reads == []

    missing = client.get(f"/api/stories/{TEST_UID}/book_none/images/manifest", headers=AUTH)
    assert missing.status_code == 200
    assert missing.headers["X-Manifest-Found"] == "false"
    assert missing.json()["_found"] is False
    assert storage.reads == [("GET", _manifest_path("book_none"))]


def test_manifest_put_updates_cache_and_etag(client, storage):
    _seed(storage, "book_a")
    url = f"/api/stories/{TEST_UID}/book_a/images/manifest"
    old_etag = client.get(url, headers=AUTH).headers["ETag"]

    new_manifest = {"version": 1, "coverId": "img_cover_0009", "images": [{"id": "img_cover_0009"}]}
    put = client.put(url, json=new_manifest, headers=AUTH)
    assert put.status_code == 200
    new_etag = put.json()["etag"]
    assert new_etag != old_etag

    storage.reads.clear()
    assert client.get(url, headers={**AUTH, "If-None-Match": old_etag}).status_code == 200
    books = _covers(client, ["book_a"], {"book_a": old_etag})
    assert books["book_a"]["manifest"]["coverId"] == "img_cover_0009"
    assert books["book_a"]["etag"] == new_etag
    assert storage.reads == []


def test_image_get_etag_304_and_cache(client, storage):
    _seed(storage, "book_a")
    url = f"/api/stories/{TEST_UID}/book_a/images/img_cover_0001"
    res = client.get(url + "?v=2026", headers=AUTH)
    assert res.status_code == 200
    assert res.content == WEBP
    assert res.headers["Cache-Control"].startswith("private, max-age=")
    etag = res.headers["ETag"]
    assert client.get(url, headers=AUTH).headers["Cache-Control"] == "private, no-cache"

    storage.reads.clear()
    assert client.get(url, headers={**AUTH, "If-None-Match": etag}).status_code == 304
    assert client.get(url, headers=AUTH).content == WEBP
    assert storage.reads == []


def test_image_replace_and_delete_invalidate_cache(client, storage):
    _seed(storage, "book_a")
    url = f"/api/stories/{TEST_UID}/book_a/images/img_cover_0001"
    etag = client.get(url, headers=AUTH).headers["ETag"]

    replacement = WEBP + b"\x01\x02"
    put = client.put(url, files={"file": ("x.webp", replacement, "image/webp")}, headers=AUTH)
    assert put.status_code == 200
    res = client.get(url, headers={**AUTH, "If-None-Match": etag})
    assert res.status_code == 200
    assert res.content == replacement

    storage.reads.clear()
    assert client.delete(url, headers=AUTH).status_code == 200
    assert ("HEAD", f"users/{TEST_UID}/images/book_a/img_cover_0001") not in storage.reads
    assert client.get(url, headers=AUTH).status_code == 404


def test_delete_all_images_and_story_storage_invalidate_cache(client, storage):
    _seed(storage, "book_a")
    _seed(storage, "book_b")
    image_url = f"/api/stories/{TEST_UID}/book_a/images/img_cover_0001"
    assert client.get(image_url, headers=AUTH).status_code == 200
    assert client.delete(f"/api/stories/{TEST_UID}/book_a/images", headers=AUTH).status_code == 200
    assert client.get(image_url, headers=AUTH).status_code == 404

    _covers(client, ["book_b"])
    assert client.get(f"/api/stories/{TEST_UID}/book_b/images/img_cover_0001", headers=AUTH).status_code == 200
    assert client.delete(f"/api/stories/{TEST_UID}/book_b/storage", headers=AUTH).status_code == 200
    books = _covers(client, ["book_b"])
    assert books["book_b"]["found"] is False
    assert client.get(f"/api/stories/{TEST_UID}/book_b/images/img_cover_0001", headers=AUTH).status_code == 404


def test_read_started_before_a_write_does_not_cache_stale_data():
    cache = image_cache_mod._ByteLRU(1024, 512)
    since = cache.writes
    cache.put(("u", "b"), b"new")
    cache.fill(("u", "b"), b"old", True, since)
    assert cache.get(("u", "b"))[0] == b"new"


def test_lru_is_bounded():
    cache = image_cache_mod._ByteLRU(max_bytes=10, max_item_bytes=6)
    cache.put(("a",), b"12345")
    cache.put(("b",), b"12345")
    cache.put(("c",), b"12345")
    cache.put(("big",), b"1234567")
    assert cache.get(("a",)) is None
    assert cache.get(("big",)) is None
    assert cache.size <= 10
