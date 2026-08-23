import io
import json
import pytest
from fastapi.testclient import TestClient
from app.server import create_app
from app.core import security, database

TEST_UID = "test_user_e2e_123"

@pytest.fixture(autouse=True)
def mock_auth(monkeypatch):
    """Bypass Firebase token validation for integration tests across all routers."""
    monkeypatch.setattr(security, "firebase_admin_initialized", True)
    monkeypatch.setattr(database, "firebase_admin_initialized", True)
    
    def fake_verify_id_token(token, clock_skew_seconds=10):
        if not token or token == "invalid_token":
            raise ValueError("Invalid token")
        return {"uid": TEST_UID, "email": "test@example.com"}
    
    monkeypatch.setattr(security.auth, "verify_id_token", fake_verify_id_token)

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
