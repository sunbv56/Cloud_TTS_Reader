from fastapi.testclient import TestClient

from app.routers import books
from app.server import create_app

BOOK = "Chương 1: Mở đầu\nĐêm khuya canh bốn, gió lạnh thổi qua.\n\nChương 2: Kết thúc\nTrời sáng, mọi chuyện đã qua.\n"


class _Blob:
    def __init__(self, path):
        self.path = path

    def download_to_filename(self, dst):
        if not self.path.endswith("parsed-test-book.txt"):
            raise FileNotFoundError(self.path)
        with open(dst, "w", encoding="utf-8") as f:
            f.write(BOOK)


class _Storage:
    def bucket(self):
        return self

    def blob(self, path):
        return _Blob(path)


async def _no_auth_error(request, user_id):
    return None


def test_parsed_story_parses_from_storage(monkeypatch):
    monkeypatch.setattr(books, "storage", _Storage())
    monkeypatch.setattr(books, "_authorization_error_async", _no_auth_error)
    client = TestClient(create_app())
    res = client.get("/api/stories/u1/s1/parsed", params={"filename": "parsed-test-book.txt"})
    assert res.status_code == 200

    # Same contract as the upload-based parser it replaces.
    uploaded = client.post("/api/parse-book",
                           files={"file": ("parsed-test-book.txt", BOOK.encode("utf-8"), "text/plain")})
    assert uploaded.status_code == 200
    assert res.json() == uploaded.json()
    assert res.json()["chapters"]


def test_parsed_story_missing_file_is_404(monkeypatch):
    monkeypatch.setattr(books, "storage", _Storage())
    monkeypatch.setattr(books, "_authorization_error_async", _no_auth_error)
    monkeypatch.setattr(books, "is_storage_not_found", lambda exc: isinstance(exc, FileNotFoundError))
    res = TestClient(create_app()).get("/api/stories/u1/s1/parsed", params={"filename": "missing.txt"})
    assert res.status_code == 404
