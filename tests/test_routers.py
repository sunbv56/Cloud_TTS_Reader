import pytest
from fastapi.testclient import TestClient
from app.server import app

client = TestClient(app)


def test_ping_endpoint():
    response = client.get("/api/ping")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"


def test_firebase_config_endpoint():
    response = client.get("/api/firebase-config")
    assert response.status_code == 200
    data = response.json()
    assert "apiKey" in data
    assert "projectId" in data


def test_devtools_suppression():
    response = client.get("/.well-known/appspecific/com.chrome.devtools.json")
    assert response.status_code == 200
    assert response.json() == {}


def test_stream_audio_unauthenticated():
    response = client.get("/stream/audio?text=Xin%20chao&voice=vi-VN-HoaiMyNeural")
    assert response.status_code == 401


def test_parse_book_invalid_extension():
    files = {"file": ("test.exe", b"binarycontent", "application/octet-stream")}
    response = client.post("/api/parse-book", files=files)
    assert response.status_code == 415


def test_index_link_preview_uses_request_origin():
    response = client.get("/", headers={"host": "nova.example.vn", "x-forwarded-proto": "https"})
    assert '<meta property="og:image" content="https://nova.example.vn/static/og-image.png">' in response.text
    assert "__ORIGIN__" not in response.text


def test_index_link_preview_ignores_forged_host():
    response = client.get("/", headers={"host": 'evil.vn"><script>alert(1)</script>'})
    assert "<script>alert(1)" not in response.text
    assert '<meta property="og:image" content="/static/og-image.png">' in response.text


def test_index_page_serves_html():
    response = client.get("/")
    assert response.status_code == 200
    assert "<title>NOVA</title>" in response.text
    assert "/static/css/console.css" in response.text
    assert "/static/js/main.js" in response.text


def test_static_modular_assets_served():
    css_res = client.get("/static/css/console.css")
    assert css_res.status_code == 200
    assert "--color-accent" in css_res.text
    assert "--theme-primary" in css_res.text

    js_res = client.get("/static/js/main.js")
    assert js_res.status_code == 200
    assert "initUIInteractions" in js_res.text


def test_append_chapters_json_validation():
    # Calling without required auth/fields returns proper 400
    response = client.post("/api/append-chapters", json={
        "userId": "test-user",
        "bookId": "test-book",
        "filename": "test.txt",
        "chapters": []
    })
    assert response.status_code in (400, 401)


def test_storage_status_endpoint():
    response = client.get("/api/system/storage-status")
    assert response.status_code in (200, 503)
    data = response.json()
    assert "status" in data
    assert "storage" in data
    assert "provider" in data["storage"]
    assert "timestamp" in data


def test_reclaim_memory_invocation():
    from app.core.memory import _reclaim_memory
    # Ensure _reclaim_memory runs cleanly without raising
    _reclaim_memory()


def test_lazy_proxies_representation():
    from app.core.database import _LazyFirestoreProxy, _LazyStorageProxy
    fs_proxy = _LazyFirestoreProxy()
    assert "LazyFirestoreProxy" in repr(fs_proxy)
    st_proxy = _LazyStorageProxy()
    assert "LazyStorageProxy" in repr(st_proxy)



