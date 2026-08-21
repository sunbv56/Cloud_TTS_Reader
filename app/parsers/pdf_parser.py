from typing import List
from app.parsers.base import chapter_from_text


def parse_pdf_chapters(file_path: str) -> List[dict]:
    """Parse PDF file into structured chapter dicts using PyPDF/pypdf."""
    try:
        from pypdf import PdfReader
    except ImportError:
        try:
            from PyPDF2 import PdfReader
        except ImportError:
            raise ValueError("pypdf or PyPDF2 is required to parse PDF files")

    reader = PdfReader(file_path)
    chapters = []
    current_text = []

    for i, page in enumerate(reader.pages):
        page_text = page.extract_text() or ""
        if page_text.strip():
            current_text.append(page_text)
            if len(current_text) >= 10:
                text = "\n\n".join(current_text)
                chapter = chapter_from_text(text, f"Chương {len(chapters) + 1}")
                if chapter:
                    chapters.append(chapter)
                current_text = []

    if current_text:
        text = "\n\n".join(current_text)
        chapter = chapter_from_text(text, f"Chương {len(chapters) + 1}")
        if chapter:
            chapters.append(chapter)

    return chapters
