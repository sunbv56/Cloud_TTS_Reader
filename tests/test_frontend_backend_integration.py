import io
import json
import os
import pytest
from fastapi.testclient import TestClient
from app.server import create_app
from app.core import security, database

TEST_UID = "test_user_e2e_123"


class _MockBlob:
    def __init__(self, path, store):
        self.path = path
        self._store = store

    def upload_from_filename(self, filename, content_type=None):
        with open(filename, "rb") as f:
            self._store[self.path] = f.read()

    def upload_from_string(self, data, content_type=None):
        if isinstance(data, str):
            self._store[self.path] = data.encode("utf-8")
        else:
            self._store[self.path] = bytes(data)

    def download_as_text(self):
        if self.path not in self._store:
            raise FileNotFoundError(f"Blob not found: {self.path}")
        val = self._store[self.path]
        return val.decode("utf-8") if isinstance(val, bytes) else str(val)

    def download_as_bytes(self):
        if self.path not in self._store:
            raise FileNotFoundError(f"Blob not found: {self.path}")
        val = self._store[self.path]
        return val if isinstance(val, bytes) else str(val).encode("utf-8")

    def download_to_filename(self, filename):
        os.makedirs(os.path.dirname(os.path.abspath(filename)), exist_ok=True)
        with open(filename, "wb") as f:
            f.write(self.download_as_bytes())

    def exists(self):
        return self.path in self._store

    def delete(self):
        self._store.pop(self.path, None)


class _MockStorageBackend:
    provider_name = "mock_storage"

    def __init__(self):
        self._files = {}

    def bucket(self):
        return self

    def blob(self, path):
        return _MockBlob(path, self._files)

    def list_keys(self, prefix):
        return [k for k in self._files if k.startswith(prefix)]

    def delete_prefix(self, prefix):
        for k in self.list_keys(prefix):
            self._files.pop(k, None)

    def is_not_found(self, exc):
        return isinstance(exc, FileNotFoundError) or "not found" in str(exc).lower()

    def get_diagnostic_info(self):
        return {"provider": "mock_storage", "bucket": "test-mock-bucket", "connected": True, "error": None}


class _MockDocSnapshot:
    def __init__(self, exists, data, doc_id):
        self.exists = exists
        self._data = data
        self.id = doc_id

    def to_dict(self):
        return dict(self._data) if self._data is not None else None


def _sanitize_mock_data(data):
    import datetime
    if isinstance(data, dict):
        new_d = {}
        for k, v in data.items():
            if hasattr(v, "__class__") and "Sentinel" in v.__class__.__name__:
                new_d[k] = datetime.datetime.now(datetime.timezone.utc)
            elif isinstance(v, dict):
                new_d[k] = _sanitize_mock_data(v)
            elif isinstance(v, list):
                new_d[k] = [_sanitize_mock_data(x) for x in v]
            else:
                new_d[k] = v
        return new_d
    elif isinstance(data, list):
        return [_sanitize_mock_data(x) for x in data]
    return data


class _MockDocRef:
    def __init__(self, path, store):
        self.path = path
        self._store = store
        self.id = path.rstrip("/").split("/")[-1]

    def set(self, data, merge=False):
        clean = _sanitize_mock_data(data)
        if merge and self.path in self._store:
            self._store[self.path].update(clean)
        else:
            self._store[self.path] = dict(clean)

    def update(self, data):
        clean = _sanitize_mock_data(data)
        if self.path in self._store:
            self._store[self.path].update(clean)
        else:
            self._store[self.path] = dict(clean)

    def get(self):
        exists = self.path in self._store
        data = self._store.get(self.path)
        return _MockDocSnapshot(exists, data, self.id)

    def delete(self):
        self._store.pop(self.path, None)

    def collection(self, name):
        return _MockCollection(f"{self.path}/{name}", self._store)


class _MockCollection:
    def __init__(self, path, store):
        self.path = path
        self._store = store

    def document(self, doc_id=None):
        if not doc_id:
            import uuid
            doc_id = str(uuid.uuid4())
        return _MockDocRef(f"{self.path}/{doc_id}", self._store)

    def stream(self):
        prefix = f"{self.path}/"
        docs = []
        for k in list(self._store.keys()):
            if k.startswith(prefix):
                suffix = k[len(prefix):]
                if "/" not in suffix:
                    docs.append(_MockDocRef(k, self._store).get())
        return docs


class _MockFirestore:
    def __init__(self):
        self._store = {}

    def collection(self, name):
        return _MockCollection(name, self._store)


@pytest.fixture(autouse=True)
def mock_auth(monkeypatch):
    """Bypass Firebase token validation and mock cloud storage/firestore for hermetic integration tests."""
    monkeypatch.setattr(security, "firebase_admin_initialized", True)
    monkeypatch.setattr(database, "firebase_admin_initialized", True)

    def fake_verify_id_token(token, clock_skew_seconds=10):
        if not token or token == "invalid_token":
            raise ValueError("Invalid token")
        return {"uid": TEST_UID, "email": "test@example.com"}

    monkeypatch.setattr(security.auth, "verify_id_token", fake_verify_id_token)

    mock_storage = _MockStorageBackend()
    mock_firestore = _MockFirestore()

    monkeypatch.setattr(database, "storage", mock_storage)
    monkeypatch.setattr(database, "db_admin", mock_firestore)

    import app.routers.books as books_mod
    monkeypatch.setattr(books_mod, "storage", mock_storage)
    monkeypatch.setattr(books_mod, "db_admin", mock_firestore)

    import app.services.book_service as bs_mod
    monkeypatch.setattr(bs_mod, "storage", mock_storage)
    monkeypatch.setattr(bs_mod, "db_admin", mock_firestore)

    import app.services.cache_service as cs_mod
    if hasattr(cs_mod, "storage"):
        monkeypatch.setattr(cs_mod, "storage", mock_storage)
    if hasattr(cs_mod, "db_admin"):
        monkeypatch.setattr(cs_mod, "db_admin", mock_firestore)

    import app.routers.system as sys_mod
    if hasattr(sys_mod, "storage"):
        monkeypatch.setattr(sys_mod, "storage", mock_storage)

@pytest.fixture
def client():
    app = create_app()
    with TestClient(app) as c:
        yield c

class TestSystemAndConfigFlow:
    def test_index_html_served(self, client):
        res = client.get("/")
        assert res.status_code == 200
        assert "<!DOCTYPE html>" in res.text
        assert "html" in res.text

    def test_ping_endpoint(self, client):
        res = client.get("/api/ping")
        assert res.status_code == 200
        assert res.json() == {"status": "ok", "message": "Keep-alive ping received"}

    def test_firebase_config_endpoint(self, client):
        res = client.get("/api/firebase-config")
        assert res.status_code == 200
        data = res.json()
        for key in ["apiKey", "authDomain", "projectId", "storageBucket", "messagingSenderId", "appId"]:
            assert key in data

    def test_storage_status(self, client):
        res = client.get("/api/system/storage-status")
        assert res.status_code in [200, 503]
        data = res.json()
        assert "status" in data
        assert "storage" in data

    def test_memory_stats_and_trim(self, client):
        stats_res = client.get("/api/system/memory-stats")
        assert stats_res.status_code == 200
        stats = stats_res.json()
        assert "python" in stats

        trim_res = client.post("/api/system/memory-trim")
        assert trim_res.status_code == 200
        assert trim_res.json()["status"] == "ok"


class TestBookAndChapterLifecycle:
    def test_parse_book_txt(self, client):
        content = "Chương 1: Mở đầu\nĐây là câu thứ nhất. Đây là câu thứ hai.\n===\nChương 2: Diễn biến\nNội dung chương 2."
        files = {"file": ("test_story.txt", io.BytesIO(content.encode("utf-8")), "text/plain")}
        res = client.post("/api/parse-book", files=files)
        assert res.status_code == 200
        data = res.json()
        assert data["title"] == "test_story"
        assert len(data["chapters"]) == 2
        assert data["chapters"][0]["title"] == "Chương 1: Mở đầu"

    def test_upload_story_lifecycle_unsegmented(self, client):
        content = "Chương 1: Khởi đầu\nCâu 1. Câu 2.\n===\nChương 2: Tiếp theo\nCâu 3. Câu 4."
        files = {"file": ("demo_novel.txt", io.BytesIO(content.encode("utf-8")), "text/plain")}
        data = {"userId": TEST_UID}
        headers = {"Authorization": "Bearer mock_valid_token"}
        res = client.post("/api/upload-story", data=data, files=files, headers=headers)
        assert res.status_code == 200
        res_data = res.json()
        assert "storyId" in res_data
        story_id = res_data["storyId"]
        canonical_filename = res_data["filename"]
        assert res_data["isSegmented"] is False

        # 1. Fetch metadata
        meta_res = client.get(f"/api/stories/{TEST_UID}/{story_id}/metadata", headers=headers)
        assert meta_res.status_code == 200
        meta = meta_res.json()
        assert meta["title"] == "demo_novel"
        assert meta["totalChapters"] == 2
        assert len(meta["chaptersSummary"]) == 2

        # 2. Get chapter sentences (via FormData payload as sent by frontend)
        sent_data = {
            "userId": TEST_UID,
            "filename": canonical_filename,
            "chapterIndex": 0
        }
        sent_res = client.post("/api/get-chapter-sentences", data=sent_data, headers=headers)
        assert sent_res.status_code == 200
        sent_json = sent_res.json()
        assert len(sent_json["sentences"]) > 0

        # 3. Get chapter content for editing (via FormData)
        edit_data = {
            "userId": TEST_UID,
            "bookId": story_id,
            "filename": canonical_filename,
            "chapterIndex": 0
        }
        content_res = client.post("/api/get-chapter-content", data=edit_data, headers=headers)
        assert content_res.status_code == 200
        content_data = content_res.json()
        assert "Chương 1: Khởi đầu" in content_data["content"]

        # 4. Update chapter (via FormData)
        update_data = {
            "userId": TEST_UID,
            "bookId": story_id,
            "filename": canonical_filename,
            "chapterIndex": 0,
            "newContent": "Chương 1: Đã sửa đổi\nCâu 1 đã sửa. Câu 2 đã sửa."
        }
        update_res = client.post("/api/update-chapter", data=update_data, headers=headers)
        assert update_res.status_code == 200
        updated_data = update_res.json()
        assert "title" in updated_data
        assert "sentences" in updated_data

        # 5. Append chapters (via JSON payload)
        append_payload = {
            "userId": TEST_UID,
            "bookId": story_id,
            "filename": canonical_filename,
            "chapters": [
                {"title": "Chương 3: Ngoại truyện", "content": "Chương 3: Ngoại truyện\nCâu mới ngoại truyện.", "included": True}
            ]
        }
        append_res = client.post("/api/append-chapters", json=append_payload, headers=headers)
        assert append_res.status_code == 200

        # Verify new chapter count
        meta_res2 = client.get(f"/api/stories/{TEST_UID}/{story_id}/metadata", headers=headers)
        assert meta_res2.status_code == 200
        assert meta_res2.json()["totalChapters"] == 3

        # 6. Export text
        export_res = client.get(f"/api/stories/{TEST_UID}/{story_id}/export-text", headers=headers)
        assert export_res.status_code == 200
        assert "Chương" in export_res.text

        # 7. Delete chapters (via FormData)
        del_data = {
            "userId": TEST_UID,
            "bookId": story_id,
            "filename": canonical_filename,
            "indices": json.dumps([2])
        }
        del_res = client.post("/api/delete-chapters", data=del_data, headers=headers)
        assert del_res.status_code == 200
        assert "chapters" in del_res.json()

        # 8. Clean up / delete story storage
        del_storage_res = client.delete(f"/api/stories/{TEST_UID}/{story_id}/storage", headers=headers)
        assert del_storage_res.status_code == 200

    def test_upload_story_lifecycle_segmented(self, client):
        # Generate > 200 chapters to trigger segmentation
        chaps = [f"Chương {i}: Tiêu đề {i}\nNội dung câu thứ nhất của chương {i}." for i in range(1, 210)]
        content = "\n===\n".join(chaps)
        files = {"file": ("large_novel.txt", io.BytesIO(content.encode("utf-8")), "text/plain")}
        data = {"userId": TEST_UID}
        headers = {"Authorization": "Bearer mock_valid_token"}
        res = client.post("/api/upload-story", data=data, files=files, headers=headers)
        assert res.status_code == 200
        res_data = res.json()
        assert res_data["isSegmented"] is True
        story_id = res_data["storyId"]

        # Fetch Segment 0 with version=2 (as requested by frontend)
        seg_res = client.get(f"/api/stories/{TEST_UID}/{story_id}/segments/0?version=2", headers=headers)
        assert seg_res.status_code == 200
        seg = seg_res.json()
        assert "chapters" in seg
        assert len(seg["chapters"]) == 50

        # Fetch Segment 4 (chapters 200-208)
        seg4_res = client.get(f"/api/stories/{TEST_UID}/{story_id}/segments/4?version=2", headers=headers)
        assert seg4_res.status_code == 200
        seg4 = seg4_res.json()
        assert "chapters" in seg4
        assert len(seg4["chapters"]) == 9

        # Clean up
        client.delete(f"/api/stories/{TEST_UID}/{story_id}/storage", headers=headers)


class TestImageManifestAndMedia:
    def test_image_manifest_crud(self, client):
        story_id = "test_img_story_1"
        headers = {"Authorization": "Bearer mock_valid_token"}

        # 1. Get initial manifest (or 404/empty)
        get_res = client.get(f"/api/stories/{TEST_UID}/{story_id}/images/manifest", headers=headers)
        assert get_res.status_code in [200, 404]

        # 2. Put new manifest
        manifest_payload = {
            "images": [
                {"id": "img1", "chapterIndex": 0, "paragraphIndex": 1, "url": "https://example.com/1.png"}
            ]
        }
        put_res = client.put(f"/api/stories/{TEST_UID}/{story_id}/images/manifest", json=manifest_payload, headers=headers)
        assert put_res.status_code in [200, 503]


class TestWebSocketTTSProtocol:
    def test_websocket_auth_and_ping(self, client):
        with client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "AUTH", "token": "mock_valid_token"})
            res = ws.receive_json()
            assert res == {"type": "AUTH_OK"}

            ws.send_json({"type": "PING"})
            pong = ws.receive_json()
            assert pong == {"type": "PONG"}
