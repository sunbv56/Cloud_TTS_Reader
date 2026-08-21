import os
import tempfile
import pytest
from app.parsers.base import (
    sanitize_slug,
    chapter_from_text,
    split_text_into_chunks,
    partition_chapters,
    build_chapters_summary,
    detect_text_encoding,
    safe_export_filename,
)
from app.parsers.txt_parser import parse_chapters_from_file, parse_chapter_at_index


def test_sanitize_slug():
    assert sanitize_slug("Truyện Kiều - Nguyễn Du") == "truyen-kieu-nguyen-du"
    assert sanitize_slug("Đắc Nhân Tâm!") == "dac-nhan-tam"
    assert sanitize_slug("Hello World 123") == "hello-world-123"


def test_chapter_from_text():
    raw_text = "Chương 1: Bắt đầu\n\nNội dung chương một ở đây.\n\n"
    chap = chapter_from_text(raw_text, "Default Title")
    assert chap is not None
    assert chap["title"] == "Chương 1: Bắt đầu"
    assert "Nội dung chương một" in chap["content"]

    empty_chap = chapter_from_text("", "Fallback")
    assert empty_chap is None


def test_split_text_into_chunks():
    text = "Câu thứ nhất. Câu thứ hai! Câu thứ ba? Một đoạn văn tiếp theo."
    chunks = split_text_into_chunks(text, max_chars=30)
    assert len(chunks) >= 2
    assert all(isinstance(c, str) and len(c) > 0 for c in chunks)


def test_partition_chapters():
    chapters = [{"title": f"Chương {i}", "content": f"Content {i}"} for i in range(125)]
    segments = partition_chapters(chapters, segment_size=50)
    assert len(segments) == 3
    assert len(segments[0]) == 50
    assert len(segments[1]) == 50
    assert len(segments[2]) == 25


def test_build_chapters_summary():
    chapters = [
        {"title": "Chương 1", "content": "Câu 1. Câu 2."},
        {"title": "Chương 2", "content": "Câu 3. Câu 4. Câu 5."},
    ]
    summary = build_chapters_summary(chapters)
    assert len(summary) == 2
    assert summary[0]["title"] == "Chương 1"
    assert summary[0]["count"] >= 1
    assert summary[1]["title"] == "Chương 2"


def test_safe_export_filename():
    meta = {"title": "Truyện / Đặc Biệt: Phần 1*"}
    safe = safe_export_filename(meta, "story123")
    assert "/" not in safe
    assert ":" not in safe
    assert "*" not in safe
    assert safe.endswith(".txt")


def test_txt_parser_with_delimiters():
    sample_content = """Chương 1: Khởi đầu
Nội dung chương 1 tại đây.

===

Chương 2: Diễn biến
Nội dung chương 2 tại đây.
"""
    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".txt", encoding="utf-8") as f:
        f.write(sample_content)
        tmp_path = f.name

    try:
        encoding = detect_text_encoding(tmp_path)
        assert encoding == "utf-8"

        chapters = parse_chapters_from_file(tmp_path)
        assert len(chapters) == 2
        assert "Khởi đầu" in chapters[0]["title"]
        assert "Diễn biến" in chapters[1]["title"]

        ch0 = parse_chapter_at_index(tmp_path, 0)
        assert ch0 is not None
        assert "Khởi đầu" in ch0["title"]

        ch1 = parse_chapter_at_index(tmp_path, 1)
        assert ch1 is not None
        assert "Diễn biến" in ch1["title"]

        ch_out_of_range = parse_chapter_at_index(tmp_path, 99)
        assert ch_out_of_range is None
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
