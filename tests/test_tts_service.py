import pytest
from app.services.tts_service import ChapterDownloadRequest, ChapterDownloadItem
from app.core.security import _validate_text_size


def test_chapter_download_request_validation():
    item = ChapterDownloadItem(
        chapterIndex=0,
        title="Chương 1",
        sentences=["Câu một", "Câu hai"]
    )
    req = ChapterDownloadRequest(
        bookTitle="Sách Thử Nghiệm",
        chapters=[item],
        voice="vi-VN-HoaiMyNeural"
    )
    assert req.bookTitle == "Sách Thử Nghiệm"
    assert len(req.chapters) == 1
    assert req.voice == "vi-VN-HoaiMyNeural"


def test_validate_text_size():
    valid = _validate_text_size("Xin chào thế giới")
    assert valid is None

    empty = _validate_text_size("")
    assert empty is not None
    assert empty.status_code == 400

    huge_text = "a" * 6000
    too_large = _validate_text_size(huge_text)
    assert too_large is not None
    assert too_large.status_code == 413
