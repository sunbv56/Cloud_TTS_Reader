"""Book segmentation, persistence and migration services."""
import os
import gc
import json
import asyncio
import tempfile
import logging
from typing import List, Optional, Tuple
from fastapi.responses import JSONResponse

from app.core.database import db_admin, storage, firestore
from app.core.config import (
    SEGMENT_CHAPTER_SIZE,
    SEGMENT_FORMAT_VERSION,
)
from app.parsers import (
    parse_chapters_from_file,
    split_text_into_chunks,
    partition_chapters,
    segment_blob_path,
    toc_blob_path,
    _should_segment_book,
    _build_segment_data,
    reconstruct_text_from_segments,
    write_canonical_text,
)
from app.services.cache_service import (
    _run_blocking,
    _run_storage,
    _run_firestore,
    _invalidate_legacy_source_cache,
)

logger = logging.getLogger("cloud_tts_reader.book_service")

_active_migrations = set()


def _is_stale_migration(migration_time: float) -> bool:
    """Consider migrations older than 5 minutes stale."""
    import time
    return (time.time() - migration_time) > 300


def _image_asset_path(user_id: str, story_id: str, image_id: str) -> str:
    """Generate image asset blob path."""
    return f"users/{user_id}/images/{story_id}/{image_id}"


def _image_manifest_path(user_id: str, story_id: str) -> str:
    """Generate image manifest blob path."""
    return f"users/{user_id}/stories/{story_id}/images_manifest.json"


def convert_firestore_data(data: dict) -> dict:
    """Convert Firestore timestamps to ISO strings or int for JSON serialization."""
    if not isinstance(data, dict):
        return data
    converted = {}
    for k, v in data.items():
        if hasattr(v, "isoformat"):
            converted[k] = v.isoformat()
        elif hasattr(v, "timestamp"):
            converted[k] = int(v.timestamp() * 1000)
        elif isinstance(v, dict):
            converted[k] = convert_firestore_data(v)
        elif isinstance(v, list):
            converted[k] = [convert_firestore_data(item) if isinstance(item, dict) else item for item in v]
        else:
            converted[k] = v
    return converted


def _upload_json_blob(blob, payload: list):
    """Serialize and upload JSON to storage without keeping large strings in memory."""
    serialized = json.dumps(payload, ensure_ascii=False)
    blob.upload_from_string(serialized, content_type="application/json; charset=utf-8")


def write_toc_cache(user_id: str, story_id: str, chapters: List[dict], counts: List[int]) -> None:
    """Rewrite toc.json after a chapter edit; /toc serves this file before metadata."""
    try:
        titles = [chap.get("title") or f"Chương {idx + 1}" for idx, chap in enumerate(chapters)]
        blob = storage.bucket().blob(toc_blob_path(user_id, story_id))
        _upload_json_blob(blob, {"titles": titles, "counts": list(counts)})
    except Exception as exc:
        logger.warning("toc_cache_refresh_failed story_id=%s error=%s", story_id, exc)


async def persist_book_segments(
    user_id: str,
    story_id: str,
    title: str,
    chapters: List[dict],
    request_id: Optional[str] = None
) -> Tuple[int, List[int], int]:
    """Partition chapters into 50-chapter segments and store them in B2/Firebase."""
    bucket = storage.bucket()
    total_chapters = len(chapters)
    segments = partition_chapters(chapters)
    chapter_counts = []

    for i, seg_chapters in enumerate(segments):
        seg_data = []
        for chap in seg_chapters:
            sentences = split_text_into_chunks(chap.get("content", ""))
            chapter_counts.append(len(sentences))
            seg_data.append({"title": chap.get("title", f"Chương {len(chapter_counts)}"), "sentences": sentences})

        seg_blob_path = segment_blob_path(user_id, story_id, i, SEGMENT_FORMAT_VERSION)
        seg_blob = bucket.blob(seg_blob_path)
        await _run_storage(
            f"upload_segment_{i}",
            _upload_json_blob,
            seg_blob,
            seg_data,
            request_id=request_id
        )
        del seg_data
        gc.collect()

    story_metadata = {
        "id": story_id,
        "title": title,
        "totalChapters": total_chapters,
        "isSegmented": True,
        "segmentFormatVersion": SEGMENT_FORMAT_VERSION,
        "segmentSize": SEGMENT_CHAPTER_SIZE,
        "segmentsCount": len(segments),
        "chapterCounts": chapter_counts,
        "updatedAt": firestore.SERVER_TIMESTAMP
    }
    story_ref = db_admin.collection("users").document(user_id).collection("stories").document(story_id)
    await _run_firestore(
        "save_story_metadata",
        story_ref.set,
        story_metadata,
        merge=True,
        request_id=request_id
    )
    return total_chapters, chapter_counts, len(segments)


async def migrate_legacy_book_to_segments(
    user_id: str,
    story_id: str,
    filename: str,
    request_id: Optional[str] = None
):
    """Migrate an unsegmented legacy story into segment JSON layout."""
    story_ref = db_admin.collection("users").document(user_id).collection("stories").document(story_id)
    tmp_path = None
    try:
        bucket = storage.bucket()
        source_blob = bucket.blob(f"users/{user_id}/files/{filename}")
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".txt")
        tmp_path = tmp.name
        tmp.close()
        await _run_storage(
            "migration.download_master", source_blob.download_to_filename, tmp_path, request_id=request_id
        )
        chapters = await _run_blocking(
            "migration.parse_master", parse_chapters_from_file, tmp_path, request_id=request_id
        )
        if not chapters:
            raise ValueError("No readable chapters found")

        title = filename.replace(".txt", "")
        await persist_book_segments(user_id, story_id, title, chapters, request_id=request_id)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


async def append_prepared_chapters(
    user_id: str,
    book_id: str,
    filename: str,
    additions: List[dict],
    request_id: Optional[str] = None
) -> Tuple[Optional[List[dict]], Optional[JSONResponse]]:
    """Append already-reviewed chapters and refresh the same storage metadata as TXT append."""
    bucket = storage.bucket()
    blob = bucket.blob(f"users/{user_id}/files/{filename}")
    if not await _run_blocking("storage.exists_master", blob.exists, request_id=request_id):
        return None, JSONResponse({"error": "File not found"}, status_code=404)
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".txt")
    tmp_path = tmp.name
    tmp.close()
    try:
        await _run_blocking("storage.download_master", blob.download_to_filename, tmp_path, request_id=request_id)
        chapters = await _run_blocking("parse_existing_book", parse_chapters_from_file, tmp_path, request_id=request_id)
        chapters.extend(additions)
        await _run_blocking("write_canonical_text", write_canonical_text, tmp_path, chapters, request_id=request_id)
        await _run_blocking("storage.upload_master", blob.upload_from_filename, tmp_path, request_id=request_id)
        _invalidate_legacy_source_cache(user_id, filename)
        total_chapters = len(chapters)
        story_ref = db_admin.collection("users").document(user_id).collection("stories").document(book_id)

        if _should_segment_book(total_chapters):
            title = filename.replace(".txt", "")
            _, chapter_counts, _ = await persist_book_segments(
                user_id, book_id, title, chapters, request_id=request_id
            )
        else:
            chapters_summary = []
            for chap in chapters:
                sentences = split_text_into_chunks(chap.get("content", ""))
                chapters_summary.append({"title": chap.get("title", ""), "count": len(sentences)})
            await _run_firestore(
                "save_unsegmented_metadata",
                story_ref.set,
                {
                    "totalChapters": total_chapters,
                    "chaptersSummary": chapters_summary,
                    "isSegmented": False,
                    "updatedAt": firestore.SERVER_TIMESTAMP,
                },
                merge=True,
                request_id=request_id,
            )
            chapter_counts = [item["count"] for item in chapters_summary]
        await _run_blocking(
            "storage.upload_toc", write_toc_cache, user_id, book_id, chapters, chapter_counts,
            request_id=request_id,
        )
        return chapters, None
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


_migrate_legacy_story = migrate_legacy_book_to_segments
_append_prepared_chapters = append_prepared_chapters
