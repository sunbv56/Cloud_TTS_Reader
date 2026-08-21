from typing import List
from app.parsers.base import chapter_from_text


def parse_epub_chapters(file_path: str) -> List[dict]:
    """Parse EPUB file into structured chapter dicts using EbookLib and BeautifulSoup."""
    from ebooklib import epub, ITEM_DOCUMENT
    from bs4 import BeautifulSoup

    book = epub.read_epub(file_path, options={"ignore_ncx": False})
    chapters = []
    for item in book.get_items_of_type(ITEM_DOCUMENT):
        soup = BeautifulSoup(item.get_content(), "html.parser")
        for node in soup(["script", "style", "nav"]):
            node.decompose()
        text = soup.get_text("\n", strip=True)
        chapter = chapter_from_text(text, f"Chương {len(chapters) + 1}")
        if chapter:
            chapters.append(chapter)
    return chapters
