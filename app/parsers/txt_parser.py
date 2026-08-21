import re
from typing import List, Optional
from app.parsers.base import detect_text_encoding


def parse_chapters_from_file(file_path: str) -> List[dict]:
    """Memory-efficient chapter parsing by reading TXT file line by line."""
    chapters = []
    current_raw_lines = []
    
    def process_raw_chapter(raw_lines):
        if not raw_lines:
            return
        raw_text = "".join(raw_lines).strip()
        if not raw_text:
            return
        
        lines = raw_text.split('\n')
        title = "Chương không tên"
        for line in lines:
            if line.strip():
                title = line.strip()
                break
        chapters.append({'title': title, 'content': raw_text})

    encoding = detect_text_encoding(file_path)
    try:
        source = open(file_path, 'r', encoding=encoding)
    except (LookupError, UnicodeError):
        source = open(file_path, 'r', encoding='utf-8', errors='replace')
    with source as f:
        for line in f:
            if re.match(r'={3,}', line.strip()):
                process_raw_chapter(current_raw_lines)
                current_raw_lines = []
            else:
                current_raw_lines.append(line)
    
    # Process last chapter
    process_raw_chapter(current_raw_lines)
    
    # Handle empty / no delimiter case
    if not chapters:
        with open(file_path, 'r', encoding=encoding, errors='replace') as f:
            full_text = f.read(1000).strip()
            if full_text:
                with open(file_path, 'r', encoding=encoding, errors='replace') as f2:
                    content = f2.read().strip()
                    if content:
                        chapters.append({'title': "Mở đầu", 'content': content})
    return chapters


def parse_chapter_at_index(file_path: str, chapter_index: int) -> Optional[dict]:
    """Read only the requested chapter from a locally cached TXT source."""
    if chapter_index < 0:
        return None

    encoding = detect_text_encoding(file_path)
    try:
        source = open(file_path, 'r', encoding=encoding)
    except (LookupError, UnicodeError):
        source = open(file_path, 'r', encoding='utf-8', errors='replace')

    current_raw_lines = []
    current_index = 0

    def process_raw_chapter(raw_lines):
        if not raw_lines:
            return None
        raw_text = "".join(raw_lines).strip()
        if not raw_text:
            return None
        title = next((line.strip() for line in raw_text.split('\n') if line.strip()), "Chương không tên")
        return {"title": title, "content": raw_text}

    with source as handle:
        for line in handle:
            if re.match(r'={3,}', line.strip()):
                chapter = process_raw_chapter(current_raw_lines)
                if chapter is not None:
                    if current_index == chapter_index:
                        return chapter
                    current_index += 1
                current_raw_lines = []
            else:
                current_raw_lines.append(line)

    chapter = process_raw_chapter(current_raw_lines)
    return chapter if chapter is not None and current_index == chapter_index else None
