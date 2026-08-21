import os
from typing import List
from app.core.memory import _reclaim_memory
from app.parsers.txt_parser import parse_chapters_from_file, parse_chapter_at_index
from app.parsers.epub_parser import parse_epub_chapters
from app.parsers.pdf_parser import parse_pdf_chapters
from app.parsers.base import (
    sanitize_slug,
    write_canonical_text,
    split_text_into_chunks,
    partition_chapters,
    build_chapters_summary,
    detect_text_encoding,
    safe_export_filename,
    chapter_from_text,
    segment_blob_path,
    _should_segment_book,
    _build_segment_data,
    reconstruct_text_from_segments,
)


def parse_book_file(file_path: str, filename: str):
    """Parse TXT, EPUB or text-based PDF into the canonical chapter format."""
    try:
        extension = os.path.splitext(filename or file_path)[1].lower()
        if extension == ".txt":
            return parse_chapters_from_file(file_path)
        if extension == ".epub":
            return parse_epub_chapters(file_path)
        if extension == ".pdf":
            return parse_pdf_chapters(file_path)
        raise ValueError("Unsupported book format")
    finally:
        _reclaim_memory()


_detect_text_encoding = detect_text_encoding

__all__ = [
    "parse_book_file",
    "parse_chapters_from_file",
    "parse_chapter_at_index",
    "parse_epub_chapters",
    "parse_pdf_chapters",
    "sanitize_slug",
    "write_canonical_text",
    "split_text_into_chunks",
    "partition_chapters",
    "build_chapters_summary",
    "detect_text_encoding",
    "_detect_text_encoding",
    "safe_export_filename",
    "chapter_from_text",
    "segment_blob_path",
    "_should_segment_book",
    "_build_segment_data",
    "reconstruct_text_from_segments",
]
