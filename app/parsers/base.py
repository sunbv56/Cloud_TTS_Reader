import os
import re
import codecs
from typing import List, Optional
from app.core.config import SEGMENT_CHAPTER_SIZE


def detect_text_encoding(file_path: str):
    """Detect the supported Unicode TXT encodings without loading the full file."""
    with open(file_path, "rb") as source:
        prefix = source.read(4)
        sample = prefix + source.read(64 * 1024)
    if sample.startswith(b"\xef\xbb\xbf"):
        return "utf-8-sig"
    if sample.startswith((b"\xff\xfe", b"\xfe\xff")):
        return "utf-16"
    # The sample can end halfway through a multi-byte UTF-8 character. An
    # incremental decoder accepts that incomplete trailing sequence while
    # still rejecting invalid bytes in the middle of the sample.
    codecs.getincrementaldecoder("utf-8")().decode(sample, final=False)
    return "utf-8"


_detect_text_encoding = detect_text_encoding


def sanitize_slug(text: str):
    """Convert Vietnamese text to clean ASCII slug."""
    text = text.lower()
    
    patterns = {
        '[àáảãạăằắẳẵặâầấẩẫậ]': 'a',
        '[èéẻẽẹêềếểễệ]': 'e',
        '[ìíỉĩị]': 'i',
        '[òóỏõọôồốổỗộơờớởỡợ]': 'o',
        '[ùúủũụưừứửữự]': 'u',
        '[ỳýỷỹỵ]': 'y',
        'đ': 'd'
    }
    for pattern, replacement in patterns.items():
        text = re.sub(pattern, replacement, text)
    
    text = re.sub(r'[^a-z0-9\s-]', '', text)
    text = re.sub(r'\s+', '-', text).strip('-')
    text = re.sub(r'-+', '-', text)
    return text


def chapter_from_text(text: str, fallback_title: str):
    """Normalize one imported document fragment into the reader chapter shape."""
    content = re.sub(r'\n{3,}', '\n\n', text or '').strip()
    if not content:
        return None
    title = next((line.strip() for line in content.splitlines() if line.strip()), fallback_title)
    return {"title": title[:300], "content": content}


_chapter_from_text = chapter_from_text


def write_canonical_text(file_path: str, chapters: List[dict]):
    """Persist every format as UTF-8 text so edit/export flows stay format-agnostic."""
    with open(file_path, "w", encoding="utf-8") as target:
        for index, chapter in enumerate(chapters):
            if index:
                target.write("\n\n===\n\n")
            target.write((chapter.get("content") or "").strip())


def split_text_into_chunks(text: str, max_chars: int = 500):
    """Split text into sentence/clause chunks under max_chars length."""
    chunks = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line:
            continue
        if len(line) <= max_chars:
            chunks.append(line)
        else:
            sentences = re.split(r'(?<=[.!?])\s+', line)
            temp_chunk = ""
            for sentence in sentences:
                if len(temp_chunk) + len(sentence) > max_chars:
                    if temp_chunk:
                        chunks.append(temp_chunk.strip())
                    temp_chunk = sentence
                else:
                    temp_chunk += " " + sentence if temp_chunk else sentence
            if temp_chunk:
                chunks.append(temp_chunk.strip())
    
    alnum_regex = re.compile(r'\w')
    return [c for c in chunks if alnum_regex.search(c)]


def partition_chapters(chapters: List[dict], segment_size: int = SEGMENT_CHAPTER_SIZE):
    """Partition chapters into bounded segments."""
    segments = []
    for i in range(0, len(chapters), segment_size):
        segment = chapters[i : i + segment_size]
        segments.append(segment)
    return segments


def build_chapters_summary(chapters: List[dict]):
    """Build lightweight chapter summary list with titles and sentence counts."""
    return [
        {"title": chap["title"], "count": len(split_text_into_chunks(chap["content"]))}
        for chap in chapters
    ]


_build_chapters_summary = build_chapters_summary


def safe_export_filename(metadata: dict, story_id: str) -> str:
    """Return a filesystem-safe UTF-8 filename for text exports."""
    raw_name = metadata.get("filename") or metadata.get("title") or story_id
    raw_name = os.path.basename(str(raw_name)).strip() or story_id
    if not raw_name.lower().endswith(".txt"):
        raw_name += ".txt"
    raw_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", raw_name)
    return raw_name[:180]


_safe_export_filename = safe_export_filename


def _build_segment_data(chapters: List[dict]):
    """Build segment structure and sentence counts from chapter dicts."""
    data = []
    counts = []
    for chap in chapters:
        sentences = split_text_into_chunks(chap.get("content", ""))
        counts.append(len(sentences))
        data.append({"title": chap.get("title", ""), "sentences": sentences})
    return data, counts


def _should_segment_book(total_chapters: int) -> bool:
    """Return True only if the book has more than 200 chapters."""
    return total_chapters > 200


def segment_blob_path(user_id: str, story_id: str, segment_index: int, format_version: int = 2) -> str:
    """Generate canonical B2/Storage blob path for a story segment."""
    if format_version >= 2:
        return f"users/{user_id}/stories/{story_id}/segments/v{format_version}/seg_{segment_index}.json"
    return f"users/{user_id}/stories/{story_id}/segments/seg_{segment_index}.json"


def reconstruct_text_from_segments(user_id: str, story_id: str, segments_count: int, format_version: int = 0) -> Optional[str]:
    """Rebuild full text from stored JSON segments as a fallback."""
    import json
    from app.core.database import storage
    if not storage:
        return None
    try:
        bucket = storage.bucket()
        chapters_text = []
        for i in range(segments_count):
            blob_path = segment_blob_path(user_id, story_id, i, format_version)
            blob = bucket.blob(blob_path)
            if not blob.exists():
                continue
            raw_data = blob.download_as_text()
            seg_data = json.loads(raw_data)
            for chap in seg_data:
                title = chap.get("title", "")
                sentences = chap.get("sentences", [])
                content = "\n".join(sentences)
                chapters_text.append(f"{title}\n\n{content}" if title else content)
        return "\n\n===\n\n".join(chapters_text) if chapters_text else None
    except Exception:
        return None
