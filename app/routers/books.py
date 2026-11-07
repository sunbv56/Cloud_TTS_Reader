import os
import gc
import json
import uuid
import asyncio
import logging
import tempfile
import time
from typing import List, Optional
from urllib.parse import quote

from fastapi import APIRouter, Request, Response, Form, UploadFile, File, BackgroundTasks, Query
from fastapi.responses import StreamingResponse, JSONResponse

from app.core import security
from app.core.config import (
    MAX_UPLOAD_BYTES,
    MAX_APPEND_BYTES,
    MAX_APPEND_CHAPTERS,
    MAX_IMAGE_BYTES,
    MAX_NEW_CONTENT_CHARS,
    SEGMENT_CHAPTER_SIZE,
    SEGMENT_FORMAT_VERSION,
)
from app.core.database import db_admin, storage, firebase_admin_initialized, is_storage_not_found, firestore
from app.core.security import (
    _request_id,
    _authorization_error,
    _authorization_error_async,
    _verify_export_owner,
    _serialized_import_route,
    _validate_book_upload,
    _validate_text_upload,
    _validate_supported_text_encoding,
    _valid_image_id,
)
from app.parsers import (
    parse_book_file,
    parse_chapters_from_file,
    parse_chapter_at_index,
    sanitize_slug,
    write_canonical_text,
    split_text_into_chunks,
    partition_chapters,
    build_chapters_summary,
    safe_export_filename,
    chapter_from_text,
    toc_blob_path,
)
from app.services.cache_service import (
    _run_blocking,
    _run_storage,
    _run_firestore,
    _save_upload_with_limit,
    _load_json_file,
    _upload_json_blob,
    _iter_temp_file,
    _get_or_download_legacy_source,
    _invalidate_legacy_source_cache,
)
from app.services.book_service import (
    segment_blob_path,
    _should_segment_book,
    _build_segment_data,
    reconstruct_text_from_segments,
    convert_firestore_data,
    _image_asset_path,
    _image_manifest_path,
    _is_stale_migration,
    _migrate_legacy_story,
    _active_migrations,
    _append_prepared_chapters,
    write_toc_cache,
)
from app.services.image_cache import (
    MISSING,
    etag_matches,
    forget_story,
    image_cache,
    manifest_cache,
)

logger = logging.getLogger("cloud_tts_reader")

router = APIRouter(tags=["Books"])


@router.post("/api/parse-book")
async def parse_book(file: UploadFile = File(...)):
    upload_error = _validate_text_upload(file)
    if upload_error:
        return upload_error
    request_id = uuid.uuid4().hex[:16]
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".txt")
    tmp_path = tmp.name
    tmp.close()

    try:
        try:
            await _save_upload_with_limit(file, tmp_path, MAX_UPLOAD_BYTES)
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=413)
        if (file.filename or "").lower().endswith(".txt"):
            encoding_error = _validate_supported_text_encoding(tmp_path)
            if encoding_error:
                return encoding_error
        try:
            chapters = await _run_blocking(
                "parse_book_file", parse_book_file, tmp_path, file.filename, request_id=request_id
            )
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=422)
        
        chapters_metadata = await _run_blocking(
            "build_chapters_summary", build_chapters_summary, chapters, request_id=request_id
        )

        return JSONResponse({
            "title": os.path.splitext(file.filename or "book")[0],
            "chapters": chapters_metadata
        })
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


IMPORT_JOB_TTL_SECONDS = 3600
_import_jobs: dict = {}


class _ImportRejected(Exception):
    def __init__(self, message: str, status_code: int):
        super().__init__(message)
        self.status_code = status_code


def _prune_import_jobs():
    cutoff = time.time() - IMPORT_JOB_TTL_SECONDS
    for job_id in [jid for jid, job in _import_jobs.items() if job["status"] != "processing" and job["updatedAt"] < cutoff]:
        del _import_jobs[job_id]


@router.post("/api/upload-story")
@_serialized_import_route
async def upload_story(
    request: Request,
    userId: str = Form(...),
    file: UploadFile = File(...),
    background: bool = Form(False)
):
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error
    upload_error = _validate_text_upload(file)
    if upload_error:
        return upload_error

    request_id = _request_id(request)
    logger.info("import_started request_id=%s filename=%s", request_id, file.filename or "-")

    story_title = os.path.splitext(file.filename or "story.txt")[0]
    story_id = sanitize_slug(story_title)
    if not story_id:
        story_id = "story"
    story_id += "_" + str(int(asyncio.get_event_loop().time()))

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".txt")
    tmp_path = tmp.name
    tmp.close()
    owns_tmp = True

    try:
        try:
            await _save_upload_with_limit(file, tmp_path, MAX_UPLOAD_BYTES)
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=413)
        if (file.filename or "").lower().endswith(".txt"):
            encoding_error = _validate_supported_text_encoding(tmp_path)
            if encoding_error:
                return encoding_error

        if background:
            # Parsing and Storage writes can outlast any sane client timeout for
            # large books, so the client polls /api/import-jobs instead of
            # holding this request open.
            _prune_import_jobs()
            job_id = uuid.uuid4().hex
            job = {"userId": userId, "storyId": story_id, "status": "processing", "updatedAt": time.time()}
            _import_jobs[job_id] = job
            job["task"] = asyncio.create_task(
                _run_import_job(job, userId, file.filename, tmp_path, story_id, story_title, request_id)
            )
            owns_tmp = False
            return JSONResponse({"status": "processing", "jobId": job_id, "storyId": story_id}, status_code=202)

        try:
            return JSONResponse(await _import_story(userId, file.filename, tmp_path, story_id, story_title, request_id))
        except _ImportRejected as exc:
            return JSONResponse({"error": str(exc)}, status_code=exc.status_code)
    finally:
        if owns_tmp and os.path.exists(tmp_path):
            os.remove(tmp_path)


async def _run_import_job(job: dict, userId: str, filename, tmp_path: str, story_id: str, story_title: str, request_id: str):
    try:
        async with security._import_semaphore:
            job["result"] = await _import_story(userId, filename, tmp_path, story_id, story_title, request_id)
        job["status"] = "done"
    except _ImportRejected as exc:
        job["status"] = "failed"
        job["error"] = str(exc)
    except Exception:
        logger.exception("import_job_failed request_id=%s story_id=%s", request_id, story_id)
        job["status"] = "failed"
        job["error"] = "Import failed on the server. Please try again."
    finally:
        job["updatedAt"] = time.time()
        job.pop("task", None)
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


@router.get("/api/import-jobs/{jobId}")
async def get_import_job(request: Request, jobId: str, userId: str = Query(...)):
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error
    job = _import_jobs.get(jobId)
    if not job or job["userId"] != userId:
        return JSONResponse({"error": "Import job not found"}, status_code=404)
    payload = {"status": job["status"], "storyId": job["storyId"]}
    if job["status"] == "done":
        payload["result"] = job["result"]
    elif job["status"] == "failed":
        payload["error"] = job["error"]
    return JSONResponse(payload)


async def _import_story(userId: str, filename, tmp_path: str, story_id: str, story_title: str, request_id: str) -> dict:
    try:
        chapters = await _run_blocking(
            "parse_book_file", parse_book_file, tmp_path, filename, request_id=request_id
        )
    except ValueError as exc:
        raise _ImportRejected(str(exc), 422)
    total_chapters = len(chapters)
    canonical_filename = f"{story_id}.txt"
    await _run_blocking("write_canonical_text", write_canonical_text, tmp_path, chapters, request_id=request_id)
    
    story_metadata = {
        "id": story_id,
        "title": story_title,
        "totalChapters": total_chapters,
        "isSegmented": _should_segment_book(total_chapters),
        "createdAt": firestore.SERVER_TIMESTAMP,
        "filename": canonical_filename,
        "sourceFilename": filename,
        "sourceFormat": os.path.splitext(filename or "")[1].lower().lstrip(".") or "txt"
    }

    bucket = storage.bucket()
    master_blob_path = f"users/{userId}/files/{canonical_filename}"
    master_blob = bucket.blob(master_blob_path)
    await _run_blocking(
        "storage.upload_master", master_blob.upload_from_filename, tmp_path, request_id=request_id
    )
    _invalidate_legacy_source_cache(userId, canonical_filename)
    story_metadata["masterPath"] = master_blob_path
    
    if story_metadata["isSegmented"]:
        segments = partition_chapters(chapters)
        story_metadata["segmentsCount"] = len(segments)
        story_metadata["segmentSize"] = SEGMENT_CHAPTER_SIZE
        story_metadata["segmentFormatVersion"] = SEGMENT_FORMAT_VERSION
        chapter_counts = []
        
        for i, seg_chapters in enumerate(segments):
            seg_data, counts = await _run_blocking(
                "build_segment", _build_segment_data, seg_chapters, request_id=request_id
            )
            chapter_counts.extend(counts)
            
            seg_blob_path = segment_blob_path(userId, story_id, i, SEGMENT_FORMAT_VERSION)
            blob = bucket.blob(seg_blob_path)
            await _run_blocking(
                "storage.upload_segment",
                _upload_json_blob,
                blob,
                seg_data,
                content_type="application/json",
                request_id=request_id,
            )
            del seg_data
            gc.collect()
        story_metadata["chapterCounts"] = chapter_counts
    else:
        chapters_summary = await _run_blocking(
            "build_chapters_summary", build_chapters_summary, chapters, request_id=request_id
        )
        story_metadata["chaptersSummary"] = chapters_summary

    # Cache lightweight TOC manifest for instant Table of Contents load
    try:
        toc_titles = [c.get("title", f"Chương {idx+1}") for idx, c in enumerate(chapters)]
        toc_counts = chapter_counts if story_metadata["isSegmented"] else [item.get("count", 0) for item in story_metadata.get("chaptersSummary", [])]
        toc_blob = bucket.blob(toc_blob_path(userId, story_id))
        await _run_blocking(
            "storage.upload_toc",
            _upload_json_blob,
            toc_blob,
            {"titles": toc_titles, "counts": toc_counts},
            content_type="application/json",
            request_id=request_id,
        )
    except Exception as toc_err:
        logger.warning("upload_toc_cache_failed story_id=%s error=%s", story_id, toc_err)

    await _run_blocking(
        "firestore.write_story_metadata",
        db_admin.collection("users").document(userId).collection("stories").document(story_id).set,
        story_metadata,
        request_id=request_id,
    )

    # Register the library entry here: a client that gave up waiting (or an
    # automation upload) never opens the book, which would orphan the story.
    await _run_blocking(
        "firestore.write_library_entry",
        db_admin.collection("users").document(userId).collection("progress").document(story_id).set,
        {
            "title": story_title,
            "filename": canonical_filename,
            "last_listened_at": firestore.SERVER_TIMESTAMP,
            "updated_at": firestore.SERVER_TIMESTAMP,
        },
        merge=True,
        request_id=request_id,
    )

    logger.info("import_completed request_id=%s story_id=%s chapters=%s", request_id, story_id, total_chapters)

    return {
        "status": "ok",
        "storyId": story_id,
        "title": story_title,
        "filename": canonical_filename,
        "isSegmented": story_metadata["isSegmented"],
        "totalChapters": total_chapters,
        "chapters": chapters_summary if not story_metadata["isSegmented"] else [],
        "chaptersSummary": chapters_summary if not story_metadata["isSegmented"] else []
    }


@router.post("/api/parse-import")
@_serialized_import_route
async def parse_import(
    request: Request,
    userId: str = Form(...),
    file: UploadFile = File(...)
):
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error
    upload_error = _validate_book_upload(file)
    if upload_error:
        return upload_error
    request_id = _request_id(request)
    suffix = os.path.splitext(file.filename or "")[1] or ".tmp"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp_path = tmp.name
    try:
        await _save_upload_with_limit(file, tmp_path, MAX_APPEND_BYTES)
        if suffix.lower() == ".txt":
            encoding_error = _validate_supported_text_encoding(tmp_path)
            if encoding_error:
                return encoding_error
        chapters = await _run_blocking(
            "parse_import_file", parse_book_file, tmp_path, file.filename, request_id=request_id
        )
        if not chapters:
            return JSONResponse({"error": "No readable chapters found"}, status_code=422)
        return JSONResponse({
            "title": os.path.splitext(file.filename or "book")[0],
            "sourceFormat": suffix.lower().lstrip("."),
            "chapters": chapters,
        })
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=422)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


@router.post("/api/append-chapters")
@_serialized_import_route
async def append_chapters(request: Request):
    content_type = request.headers.get("content-type", "").lower()
    if "application/json" in content_type:
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "Invalid JSON payload"}, status_code=400)
        user_id = str(body.get("userId") or "")
        book_id = str(body.get("bookId") or "")
        filename = str(body.get("filename") or "")
        raw_chapters = body.get("chapters")
    else:
        try:
            form = await request.form(max_part_size=MAX_APPEND_BYTES, max_fields=2000)
        except Exception as exc:
            logger.warning("append_chapters_form_parse_failed error=%s", exc)
            return JSONResponse({"error": f"Form payload error: {exc}"}, status_code=400)
        user_id = str(form.get("userId") or "")
        book_id = str(form.get("bookId") or "")
        filename = str(form.get("filename") or "")
        chapters_raw = form.get("chapters")
        if isinstance(chapters_raw, str):
            try:
                raw_chapters = json.loads(chapters_raw)
            except Exception:
                raw_chapters = None
        else:
            raw_chapters = chapters_raw

    if not user_id or not book_id or not filename:
        return JSONResponse({"error": "userId, bookId and filename are required"}, status_code=400)

    auth_error = _authorization_error(request, user_id)
    if auth_error:
        return auth_error

    try:
        if not isinstance(raw_chapters, list) or not raw_chapters:
            raise ValueError("At least one chapter is required")
        if len(raw_chapters) > MAX_APPEND_CHAPTERS:
            raise ValueError(f"Too many chapters selected (max {MAX_APPEND_CHAPTERS})")
        additions = []
        for raw in raw_chapters:
            if not isinstance(raw, dict):
                raise ValueError("Invalid chapter format")
            chapter = chapter_from_text(str(raw.get("content") or ""), str(raw.get("title") or "Chương không tên"))
            if chapter:
                additions.append(chapter)
        if not additions:
            raise ValueError("No non-empty chapters selected")
    except ValueError as exc:
        logger.warning("append_chapters_validation_failed error=%s", exc)
        return JSONResponse({"error": str(exc)}, status_code=400)

    result, error = await _append_prepared_chapters(
        user_id, book_id, filename, additions, request_id=_request_id(request)
    )
    if error:
        logger.warning("append_chapters_processing_failed error=%s", error)
    return error or JSONResponse(result)


@router.get("/api/stories/{userId}/{storyId}/metadata")
async def get_story_metadata(request: Request, userId: str, storyId: str):
    auth_error = await _authorization_error_async(request, userId)
    if auth_error:
        return auth_error
    
    doc_ref = db_admin.collection("users").document(userId).collection("stories").document(storyId)
    doc = await _run_firestore(
        "firestore.read_story_metadata", doc_ref.get, request_id=_request_id(request)
    )
    if not doc.exists:
        return JSONResponse({"error": "Story not found"}, status_code=404)
    
    return JSONResponse(convert_firestore_data(doc.to_dict()))


@router.post("/api/stories/{userId}/{storyId}/migrate")
async def migrate_legacy_story(
    request: Request,
    background_tasks: BackgroundTasks,
    userId: str,
    storyId: str,
    filename: str = Query(...),
):
    auth_error = await _authorization_error_async(request, userId)
    if auth_error:
        return auth_error
    if storage is None or db_admin is None:
        return JSONResponse({"error": "Storage backend is not configured"}, status_code=503)

    request_id = _request_id(request)
    story_ref = db_admin.collection("users").document(userId).collection("stories").document(storyId)
    try:
        story_doc = await _run_firestore("migration.read_status", story_ref.get, request_id=request_id)
        existing = story_doc.to_dict() if story_doc.exists else {}
    except Exception:
        logger.exception("legacy_migration_status_read_failed story_id=%s", storyId)
        return JSONResponse({"error": "Migration status unavailable", "retryable": True}, status_code=503)

    if (
        existing.get("segmentationState") == "ready"
        and existing.get("isSegmented")
        and int(existing.get("segmentFormatVersion") or 0) >= SEGMENT_FORMAT_VERSION
        and int(existing.get("segmentSize") or 0) == SEGMENT_CHAPTER_SIZE
    ):
        return JSONResponse({"status": "ready", "isSegmented": True})
    key = (userId, storyId)
    if key in _active_migrations:
        return JSONResponse({"status": "processing", "retryable": True}, status_code=202)
    if existing.get("segmentationState") == "processing" and not _is_stale_migration(
        existing.get("segmentationStartedAt")
    ):
        return JSONResponse({"status": "processing", "retryable": True}, status_code=202)

    try:
        await _run_firestore(
            "migration.mark_processing",
            story_ref.set,
            {
                "id": storyId,
                "filename": filename,
                "segmentationState": "processing",
                "segmentationStartedAt": firestore.SERVER_TIMESTAMP,
            },
            merge=True,
            request_id=request_id,
        )
    except Exception:
        logger.exception("legacy_migration_status_write_failed story_id=%s", storyId)
        return JSONResponse({"error": "Migration could not start", "retryable": True}, status_code=503)

    _active_migrations.add(key)
    background_tasks.add_task(_migrate_legacy_story, userId, storyId, filename, request_id)
    return JSONResponse({"status": "processing", "retryable": True}, status_code=202)


@router.get("/api/stories/{userId}/{storyId}/segments/{segmentIndex}")
async def get_segment_data(
    request: Request,
    userId: str,
    storyId: str,
    segmentIndex: int,
    version: int = Query(0, ge=0, le=SEGMENT_FORMAT_VERSION),
):
    auth_error = await _authorization_error_async(request, userId)
    if auth_error:
        return auth_error
    
    bucket = storage.bucket()
    blob_path = segment_blob_path(userId, storyId, segmentIndex, version)
    blob = bucket.blob(blob_path)
    
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".json")
    tmp_path = tmp.name
    tmp.close()
    try:
        try:
            await _run_storage(
                "storage.download_segment", blob.download_to_filename, tmp_path,
                request_id=_request_id(request)
            )
        except Exception as exc:
            if is_storage_not_found(exc):
                return JSONResponse({"error": "Segment not found"}, status_code=404)
            logger.exception("segment_download_failed story_id=%s segment=%s", storyId, segmentIndex)
            return JSONResponse({"error": "Segment storage unavailable", "retryable": True}, status_code=503)
        try:
            data = await _run_blocking(
                "storage.parse_segment", _load_json_file, tmp_path, request_id=_request_id(request)
            )
        except (TypeError, ValueError, json.JSONDecodeError):
            return JSONResponse({"error": "Segment data is invalid"}, status_code=502)
    except Exception as exc:
        logger.exception("segment_download_failed story_id=%s segment=%s", storyId, segmentIndex)
        return JSONResponse({"error": "Segment storage unavailable", "retryable": True}, status_code=503)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
    if not isinstance(data, list):
        return JSONResponse({"error": "Segment data is invalid"}, status_code=502)
    return JSONResponse({"chapters": data})


@router.get("/api/stories/{userId}/{storyId}/toc")
async def get_story_toc(request: Request, userId: str, storyId: str):
    auth_error = await _authorization_error_async(request, userId)
    if auth_error:
        return auth_error
    if storage is None:
        return JSONResponse({"error": "Storage unavailable"}, status_code=503)

    bucket = storage.bucket()
    toc_path = toc_blob_path(userId, storyId)
    toc_blob = bucket.blob(toc_path)

    meta = None
    try:
        story_doc = await _run_firestore(
            "firestore.get_story_for_toc",
            db_admin.collection("users").document(userId).collection("stories").document(storyId).get,
            request_id=_request_id(request),
        )
        if not story_doc.exists:
            return JSONResponse({"error": "Story not found"}, status_code=404)
        meta = story_doc.to_dict() or {}
    except Exception as exc:
        logger.warning("toc_metadata_read_failed storyId=%s error=%s", storyId, exc)

    # toc.json from before a chapter edit is stale; the metadata counts are the source of truth.
    expected_counts = None
    if meta:
        expected_counts = (
            meta.get("chapterCounts") if meta.get("isSegmented")
            else [item.get("count", 0) for item in meta.get("chaptersSummary") or []]
        )

    # 1. Fast path: If pre-generated toc.json exists, return it directly
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".json")
    tmp_path = tmp.name
    tmp.close()
    try:
        try:
            await _run_storage(
                "storage.download_toc", toc_blob.download_to_filename, tmp_path,
                request_id=_request_id(request)
            )
            toc_data = await _run_blocking(
                "storage.parse_toc", _load_json_file, tmp_path, request_id=_request_id(request)
            )
            if isinstance(toc_data, dict) and "titles" in toc_data and (
                not expected_counts or toc_data.get("counts") == expected_counts
            ):
                return JSONResponse(toc_data)
        except Exception as exc:
            if not is_storage_not_found(exc):
                logger.warning("toc_read_failed storyId=%s error=%s", storyId, exc)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

    # 2. Fallback path for legacy or stale books: rebuild the TOC from Firestore metadata or segments
    if meta is None:
        return JSONResponse({"error": "Failed to load TOC", "retryable": True}, status_code=503)
    try:
        titles = []
        counts = []

        if not meta.get("isSegmented") and meta.get("chaptersSummary"):
            for item in meta["chaptersSummary"]:
                titles.append(item.get("title", ""))
                counts.append(item.get("count", 0))
        elif meta.get("isSegmented") and meta.get("segmentsCount"):
            segments_count = int(meta["segmentsCount"])
            version = int(meta.get("segmentFormatVersion") or 0)
            for seg_idx in range(segments_count):
                seg_blob = bucket.blob(segment_blob_path(userId, storyId, seg_idx, version))
                tmp_seg = tempfile.NamedTemporaryFile(delete=False, suffix=".json")
                tmp_seg_path = tmp_seg.name
                tmp_seg.close()
                try:
                    await _run_storage(
                        "storage.download_seg_for_toc", seg_blob.download_to_filename, tmp_seg_path,
                        request_id=_request_id(request)
                    )
                    seg_data = await _run_blocking(
                        "storage.parse_seg_for_toc", _load_json_file, tmp_seg_path, request_id=_request_id(request)
                    )
                    if isinstance(seg_data, list):
                        for c in seg_data:
                            titles.append(c.get("title", f"Chương {len(titles)+1}"))
                            counts.append(len(c.get("sentences", [])))
                    del seg_data
                except Exception as seg_err:
                    logger.warning("seg_read_error seg=%s error=%s", seg_idx, seg_err)
                finally:
                    if os.path.exists(tmp_seg_path):
                        os.remove(tmp_seg_path)

        toc_payload = {"titles": titles, "counts": counts}
        if titles:
            try:
                await _run_blocking(
                    "storage.cache_toc",
                    _upload_json_blob,
                    toc_blob,
                    toc_payload,
                    content_type="application/json",
                    request_id=_request_id(request),
                )
            except Exception as e:
                logger.warning("failed_to_cache_toc storyId=%s error=%s", storyId, e)

        return JSONResponse(toc_payload)
    except Exception as exc:
        logger.exception("toc_generation_failed storyId=%s", storyId)
        return JSONResponse({"error": "Failed to load TOC", "retryable": True}, status_code=500)


EMPTY_IMAGE_MANIFEST = {"version": 1, "coverId": None, "images": []}
MAX_COVER_BATCH = 100


async def _load_manifest_entry(userId: str, storyId: str, req_id: str):
    """(raw bytes, etag, found) for a story's image manifest: memory first,
    then ONE storage GET (a missing object is a 404, never HEAD + GET)."""
    key = (userId, storyId)
    cached = manifest_cache.get(key)
    if cached is not None:
        raw, etag = cached
        return raw, etag, raw != MISSING
    since = manifest_cache.writes
    blob = storage.bucket().blob(_image_manifest_path(userId, storyId))
    try:
        raw = await _run_storage("storage.download_image_manifest", blob.download_as_bytes, request_id=req_id)
    except Exception as exc:
        if not is_storage_not_found(exc):
            raise
        return MISSING, manifest_cache.fill(key, MISSING, False, since), False
    json.loads(raw)  # never cache (or serve as cached) a corrupted manifest
    return raw, manifest_cache.fill(key, raw, True, since), True


def _image_url(userId: str, storyId: str, image: dict) -> str:
    version = str(image.get("updatedAt") or image.get("createdAt") or "")
    url = f"/api/stories/{quote(userId, safe='')}/{quote(storyId, safe='')}/images/{quote(str(image.get('id')), safe='')}"
    return f"{url}?v={quote(version, safe='')}" if version else url


def _manifest_cover(userId: str, storyId: str, manifest) -> Optional[dict]:
    if not isinstance(manifest, dict) or not isinstance(manifest.get("images"), list):
        return None
    images = [image for image in manifest["images"] if isinstance(image, dict) and image.get("id")]
    cover = next((image for image in images if image.get("id") == manifest.get("coverId")), None) or (images[0] if images else None)
    if cover is None:
        return None
    return {
        "id": cover["id"],
        "v": str(cover.get("updatedAt") or cover.get("createdAt") or ""),
        "url": _image_url(userId, storyId, cover),
        "crop": cover.get("coverCrop"),
    }


def _valid_story_id(story_id) -> bool:
    return (
        isinstance(story_id, str)
        and 0 < len(story_id) <= 200
        and "/" not in story_id
        and "\\" not in story_id
        and story_id not in {".", ".."}
    )


@router.get("/api/stories/{userId}/{storyId}/images/manifest")
async def get_image_manifest(request: Request, userId: str, storyId: str):
    auth_error = await _authorization_error_async(request, userId)
    if auth_error:
        return auth_error
    if storage is None:
        return JSONResponse(
            {"error": "Storage backend is not configured", "version": 1, "coverId": None, "images": []},
            status_code=503,
            headers={"X-Storage-Backend": "none", "X-Manifest-Found": "false"}
        )
    backend_name = getattr(storage, "provider_name", "unknown")
    req_id = _request_id(request)
    headers = {"X-Storage-Backend": backend_name}

    try:
        raw, etag, found = await _load_manifest_entry(userId, storyId, req_id)
    except (ValueError, json.JSONDecodeError) as exc:
        logger.error("image_manifest_corrupted story_id=%s error=%s", storyId, exc)
        return JSONResponse({"error": "Image manifest is invalid"}, status_code=502, headers=headers)
    except Exception:
        logger.exception("image_manifest_download_failed story_id=%s backend=%s", storyId, backend_name)
        return JSONResponse(
            {"error": f"Image storage unavailable ({backend_name})", "retryable": True},
            status_code=503,
            headers=headers
        )
    headers.update({
        "X-Manifest-Found": "true" if found else "false",
        "ETag": etag,
        "Cache-Control": "private, no-cache",
    })
    if etag_matches(request.headers.get("if-none-match"), etag):
        return Response(status_code=304, headers=headers)
    if not found:
        logger.info("image_manifest_not_found story_id=%s user_id=%s backend=%s req_id=%s",
                    storyId, userId, backend_name, req_id)
    data = json.loads(raw) if found else dict(EMPTY_IMAGE_MANIFEST)
    if isinstance(data, dict):
        data["_storage_backend"] = backend_name
        data["_found"] = found
    return JSONResponse(data, headers=headers)


@router.post("/api/stories/{userId}/covers")
async def get_story_covers(request: Request, userId: str, payload: dict):
    """Manifests + cover URLs for many books in one request (Home/library).
    `etags` maps bookId -> the manifest ETag the client already holds; those
    books come back as notModified without the manifest body."""
    auth_error = await _authorization_error_async(request, userId)
    if auth_error:
        return auth_error
    if storage is None:
        return JSONResponse({"error": "Storage backend is not configured"}, status_code=503)
    book_ids = payload.get("bookIds")
    known = payload.get("etags") or {}
    if not isinstance(book_ids, list) or not isinstance(known, dict):
        return JSONResponse({"error": "bookIds must be a list"}, status_code=400)
    if len(book_ids) > MAX_COVER_BATCH:
        return JSONResponse({"error": f"At most {MAX_COVER_BATCH} books per request"}, status_code=413)
    if not all(_valid_story_id(book_id) for book_id in book_ids):
        return JSONResponse({"error": "Invalid book id"}, status_code=400)
    book_ids = list(dict.fromkeys(book_ids))
    backend_name = getattr(storage, "provider_name", "unknown")
    req_id = _request_id(request)

    async def one(story_id: str) -> dict:
        try:
            raw, etag, found = await _load_manifest_entry(userId, story_id, req_id)
            manifest = json.loads(raw) if found else dict(EMPTY_IMAGE_MANIFEST)
        except (ValueError, json.JSONDecodeError):
            logger.error("image_manifest_corrupted story_id=%s", story_id)
            return {"error": "Image manifest is invalid", "retryable": False}
        except Exception:
            logger.exception("image_manifest_download_failed story_id=%s backend=%s", story_id, backend_name)
            return {"error": f"Image storage unavailable ({backend_name})", "retryable": True}
        item = {"found": found, "etag": etag, "cover": _manifest_cover(userId, story_id, manifest)}
        if known.get(story_id) == etag:
            item["notModified"] = True
        else:
            item["manifest"] = manifest
        return item

    results = await asyncio.gather(*(one(book_id) for book_id in book_ids))
    return JSONResponse(
        {"books": dict(zip(book_ids, results))},
        headers={"X-Storage-Backend": backend_name, "Cache-Control": "private, no-store"},
    )


@router.put("/api/stories/{userId}/{storyId}/images/manifest")
async def put_image_manifest(request: Request, userId: str, storyId: str, manifest: dict):
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error
    if storage is None:
        return JSONResponse({"error": "Storage backend is not configured"}, status_code=503)
    payload = json.dumps(manifest, ensure_ascii=False)
    raw = payload.encode("utf-8")
    if len(raw) > 100 * 1024:
        return JSONResponse({"error": "Image manifest is too large"}, status_code=413)
    try:
        storage.bucket().blob(_image_manifest_path(userId, storyId)).upload_from_string(
            payload,
            content_type="application/json",
        )
    except Exception:
        manifest_cache.pop((userId, storyId))
        raise
    etag = manifest_cache.put((userId, storyId), raw)
    return JSONResponse({"status": "ok", "etag": etag}, headers={"ETag": etag})


async def _save_image_object(request: Request, userId: str, storyId: str, imageId: str, file: UploadFile):
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error
    if storage is None:
        return JSONResponse({"error": "Storage backend is not configured"}, status_code=503)
    if not _valid_image_id(imageId):
        return JSONResponse({"error": "Invalid image id"}, status_code=400)
    content_type = (file.content_type or "").lower().split(";", 1)[0].strip()
    if content_type != "image/webp":
        return JSONResponse({"error": "Only WebP images are supported"}, status_code=415)
    data = await file.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        return JSONResponse({"error": f"Image exceeds the {MAX_IMAGE_BYTES} byte limit"}, status_code=413)
    try:
        storage.bucket().blob(_image_asset_path(userId, storyId, imageId)).upload_from_string(
            data,
            content_type="image/webp",
        )
    except Exception:
        image_cache.pop((userId, storyId, imageId))
        raise
    image_cache.put((userId, storyId, imageId), data)
    return JSONResponse({
        "status": "ok",
        "id": imageId,
        "path": _image_asset_path(userId, storyId, imageId),
    })


@router.post("/api/stories/{userId}/{storyId}/images")
async def upload_story_image(
    request: Request,
    userId: str,
    storyId: str,
    imageId: str = Form(...),
    file: UploadFile = File(...),
):
    return await _save_image_object(request, userId, storyId, imageId, file)


@router.put("/api/stories/{userId}/{storyId}/images/{imageId}")
async def replace_story_image(
    request: Request,
    userId: str,
    storyId: str,
    imageId: str,
    file: UploadFile = File(...),
):
    return await _save_image_object(request, userId, storyId, imageId, file)


@router.get("/api/stories/{userId}/{storyId}/images/{imageId}")
async def get_story_image(request: Request, userId: str, storyId: str, imageId: str):
    auth_error = await _authorization_error_async(request, userId)
    if auth_error:
        return auth_error
    backend_name = getattr(storage, "provider_name", "unknown") if storage else "none"
    headers = {"X-Storage-Backend": backend_name}
    if storage is None or not _valid_image_id(imageId):
        return JSONResponse({"error": "Image not found"}, status_code=404, headers=headers)
    key = (userId, storyId, imageId)
    cached = image_cache.get(key)
    if cached is not None:
        data, etag = cached
    else:
        since = image_cache.writes
        asset_path = _image_asset_path(userId, storyId, imageId)
        blob = storage.bucket().blob(asset_path)
        req_id = _request_id(request)
        try:
            data = await _run_storage(
                "storage.download_image", blob.download_as_bytes, request_id=req_id
            )
        except Exception as exc:
            if is_storage_not_found(exc):
                logger.info("story_image_not_found story_id=%s image_id=%s path=%s backend=%s req_id=%s",
                            storyId, imageId, asset_path, backend_name, req_id)
                return JSONResponse({"error": "Image not found"}, status_code=404, headers=headers)
            logger.exception("image_download_failed story_id=%s image_id=%s backend=%s req_id=%s",
                             storyId, imageId, backend_name, req_id)
            return JSONResponse(
                {"error": f"Image storage unavailable ({backend_name})", "retryable": True},
                status_code=503,
                headers=headers
            )
        etag = image_cache.fill(key, data, True, since)
    # ?v= is the manifest's updatedAt/createdAt: a replaced image gets a new URL,
    # so a versioned URL may be reused for a while; a bare one is revalidated.
    headers["ETag"] = etag
    headers["Cache-Control"] = "private, max-age=604800" if request.query_params.get("v") else "private, no-cache"
    if etag_matches(request.headers.get("if-none-match"), etag):
        return Response(status_code=304, headers=headers)
    return Response(content=data, media_type="image/webp", headers=headers)


@router.delete("/api/stories/{userId}/{storyId}/images/{imageId}")
async def delete_story_image(request: Request, userId: str, storyId: str, imageId: str):
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error
    if storage is None or not _valid_image_id(imageId):
        return JSONResponse({"status": "ok"})
    image_cache.pop((userId, storyId, imageId))
    try:
        storage.bucket().blob(_image_asset_path(userId, storyId, imageId)).delete()
    except Exception as exc:
        if not is_storage_not_found(exc):
            raise
    return JSONResponse({"status": "ok"})


@router.delete("/api/stories/{userId}/{storyId}/images")
async def delete_story_images(request: Request, userId: str, storyId: str):
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error
    image_cache.pop_prefix((userId, storyId))
    if storage is not None:
        storage.delete_prefix(f"users/{userId}/images/{storyId}/")
    return JSONResponse({"status": "ok"})


@router.get("/api/stories/{userId}/{storyId}/file")
async def get_story_file(request: Request, userId: str, storyId: str, filename: str = Query(...)):
    auth_error = await _authorization_error_async(request, userId)
    if auth_error:
        return auth_error
    if storage is None:
        return JSONResponse({"error": "Storage backend is not configured"}, status_code=503)
    blob = storage.bucket().blob(f"users/{userId}/files/{filename}")
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".txt")
    tmp_path = tmp.name
    tmp.close()
    try:
        await _run_storage(
            "storage.download_legacy_file", blob.download_to_filename, tmp_path,
            request_id=_request_id(request)
        )
    except Exception as exc:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        if is_storage_not_found(exc):
            return JSONResponse({"error": "File not found"}, status_code=404)
        logger.exception("legacy_file_download_failed story_id=%s", storyId)
        return JSONResponse({"error": "File storage unavailable", "retryable": True}, status_code=503)
    return StreamingResponse(_iter_temp_file(tmp_path), media_type="text/plain")


@router.get("/api/stories/{userId}/{storyId}/parsed")
async def get_parsed_story(request: Request, userId: str, storyId: str, filename: str = Query(...)):
    """Parse a legacy book straight from storage. Opening one used to download
    the whole file to the client and upload it back to /api/parse-book; this
    skips both transfers and warms the disk cache used by per-chapter reads."""
    auth_error = await _authorization_error_async(request, userId)
    if auth_error:
        return auth_error
    if storage is None:
        return JSONResponse({"error": "Storage backend is not configured"}, status_code=503)
    request_id = _request_id(request)
    blob = storage.bucket().blob(f"users/{userId}/files/{filename}")
    cached_path, is_cached = None, False
    try:
        try:
            cached_path, is_cached = await _run_storage(
                "storage.cache_legacy_book_source", _get_or_download_legacy_source,
                blob.download_to_filename, userId, filename, request_id=request_id,
            )
        except Exception as exc:
            if is_storage_not_found(exc):
                return JSONResponse({"error": "File not found"}, status_code=404)
            logger.exception("legacy_parse_download_failed story_id=%s", storyId)
            return JSONResponse({"error": "File storage unavailable", "retryable": True}, status_code=503)
        if filename.lower().endswith(".txt"):
            encoding_error = _validate_supported_text_encoding(cached_path)
            if encoding_error:
                return encoding_error
        try:
            chapters = await _run_blocking(
                "parse_book_file", parse_book_file, cached_path, filename, request_id=request_id
            )
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=422)
        chapters_metadata = await _run_blocking(
            "build_chapters_summary", build_chapters_summary, chapters, request_id=request_id
        )
        return JSONResponse({
            "title": os.path.splitext(filename)[0],
            "chapters": chapters_metadata,
        })
    finally:
        if cached_path and not is_cached and os.path.exists(cached_path):
            os.remove(cached_path)


@router.delete("/api/stories/{userId}/{storyId}/storage")
async def delete_story_storage(request: Request, userId: str, storyId: str, filename: Optional[str] = Query(None)):
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error
    if storage is not None:
        if filename:
            file_blob = storage.bucket().blob(f"users/{userId}/files/{filename}")
            if file_blob.exists():
                file_blob.delete()
            _invalidate_legacy_source_cache(userId, filename)
        forget_story(userId, storyId)
        storage.delete_prefix(f"users/{userId}/stories/{storyId}/")
        storage.delete_prefix(f"users/{userId}/images/{storyId}/")
        forget_story(userId, storyId)
    return JSONResponse({"status": "ok"})


@router.get("/api/stories/{userId}/{storyId}/export-text")
async def export_story_text(userId: str, storyId: str, request: Request):
    """Download the canonical TXT, rebuilding it from segments only as a fallback."""
    if not firebase_admin_initialized or db_admin is None:
        return JSONResponse({"error": "Firebase Admin not initialized"}, status_code=500)

    auth_error = _verify_export_owner(request, userId)
    if auth_error:
        return auth_error

    story_ref = db_admin.collection("users").document(userId).collection("stories").document(storyId)
    story_doc = story_ref.get()
    if not story_doc.exists:
        return JSONResponse({"error": "Story not found"}, status_code=404)

    metadata = story_doc.to_dict() or {}
    filename = safe_export_filename(metadata, storyId)
    bucket = storage.bucket()
    master_path = metadata.get("masterPath") or f"users/{userId}/files/{metadata.get('filename', filename)}"
    master_blob = bucket.blob(master_path)

    if master_blob.exists():
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".txt")
        tmp_path = tmp.name
        tmp.close()
        try:
            master_blob.download_to_filename(tmp_path)
        except Exception as exc:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
            return JSONResponse({"error": f"Unable to read source file: {exc}"}, status_code=502)

        def master_stream():
            try:
                with open(tmp_path, "rb") as source:
                    while chunk := source.read(1024 * 1024):
                        yield chunk
            finally:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)

        headers = {
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
            "X-Export-Source": "master"
        }
        return StreamingResponse(master_stream(), media_type="text/plain; charset=utf-8", headers=headers)

    segments_count = int(metadata.get("segmentsCount") or 0)
    if not metadata.get("isSegmented") or segments_count <= 0:
        return JSONResponse({"error": "Source text file not found"}, status_code=404)

    segment_blobs = []
    segment_version = int(metadata.get("segmentFormatVersion") or 0)
    for segment_index in range(segments_count):
        blob = bucket.blob(segment_blob_path(userId, storyId, segment_index, segment_version))
        if not blob.exists():
            return JSONResponse({
                "error": "Book segments are incomplete",
                "missingSegment": segment_index
            }, status_code=409)
        segment_blobs.append(blob)

    for segment_index, blob in enumerate(segment_blobs):
        try:
            json.loads(blob.download_as_text())
        except Exception as exc:
            logger.error("[Export] Invalid segment %d: %s", segment_index, exc)
            return JSONResponse({
                "error": "Book segments are corrupted",
                "invalidSegment": segment_index
            }, status_code=409)

    def reconstructed_stream():
        first_chapter = True
        try:
            for blob in segment_blobs:
                data = json.loads(blob.download_as_text())
                for chapter in data:
                    if not first_chapter:
                        yield b"\n\n===\n\n"
                    title = str(chapter.get("title") or "Ch\u01b0\u01a1ng kh\u00f4ng t\u00ean").strip()
                    sentences = chapter.get("sentences") or []
                    text = title
                    if sentences:
                        text += "\n" + "\n".join(str(sentence) for sentence in sentences)
                    yield text.encode("utf-8")
                    first_chapter = False
                del data
                gc.collect()
        except Exception as exc:
            logger.error("[Export] Segment reconstruction failed: %s", exc)

    headers = {
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
        "X-Export-Source": "reconstructed"
    }
    return StreamingResponse(reconstructed_stream(), media_type="text/plain; charset=utf-8", headers=headers)


@router.post("/api/get-chapter-sentences")
async def get_chapter_sentences(
    request: Request,
    userId: str = Form(...),
    filename: str = Form(...),
    chapterIndex: int = Form(...)
):
    auth_error = await _authorization_error_async(request, userId)
    if auth_error:
        return auth_error

    request_id = _request_id(request)
    try:
        bucket = storage.bucket()
        blob_path = f"users/{userId}/files/{filename}"
        blob = bucket.blob(blob_path)
        cached_path = None
        is_cached = False
        try:
            cached_path, is_cached = await _run_storage(
                "storage.cache_legacy_chapter_source",
                _get_or_download_legacy_source,
                blob.download_to_filename,
                userId,
                filename,
                request_id=request_id,
            )
            chapters = await _run_blocking(
                "parse_legacy_chapter_source", parse_chapter_at_index, cached_path, chapterIndex,
                request_id=request_id,
            )
            if chapters:
                sentences = await _run_blocking(
                    "split_legacy_chapter", split_text_into_chunks,
                    chapters['content'], request_id=request_id
                )
                return JSONResponse({"sentences": sentences})
            else:
                return JSONResponse({"error": "Chapter index out of range"}, status_code=400)
        finally:
            if cached_path and not is_cached and os.path.exists(cached_path):
                os.remove(cached_path)
    except Exception as exc:
        if is_storage_not_found(exc):
            return JSONResponse({"error": "File not found"}, status_code=404)
        logger.exception("legacy_chapter_download_failed filename=%s chapter=%s", filename, chapterIndex)
        return JSONResponse({"error": "Chapter source unavailable", "retryable": True}, status_code=503)


@router.post("/api/append-chapter")
async def append_chapter(
    request: Request,
    userId: str = Form(...),
    bookId: str = Form(...),
    filename: str = Form(...),
    file: UploadFile = File(...)
):
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error

    try:
        bucket = storage.bucket()
    except Exception as e:
        return JSONResponse({"error": f"Could not access storage bucket: {e}"}, status_code=500)

    blob_path = f"users/{userId}/files/{filename}"
    blob = bucket.blob(blob_path)

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".txt")
    tmp_path = tmp.name
    tmp.close()
    try:
        is_recovered = False
        if not blob.exists() and bookId:
            story_ref = db_admin.collection("users").document(userId).collection("stories").document(bookId)
            story_doc = story_ref.get()
            if story_doc.exists:
                meta = story_doc.to_dict()
                if meta.get("isSegmented") and meta.get("segmentsCount"):
                    recovered_text = reconstruct_text_from_segments(
                        userId, bookId, meta["segmentsCount"], int(meta.get("segmentFormatVersion") or 0)
                    )
                    if recovered_text:
                        with open(tmp_path, "w", encoding="utf-8") as f:
                            f.write(recovered_text + "\n\n")
                        is_recovered = True

        if not is_recovered and blob.exists():
            blob.download_to_filename(tmp_path)
            with open(tmp_path, "a", encoding="utf-8") as f:
                f.write("\n\n")

        appended_path = tempfile.NamedTemporaryFile(delete=False, suffix=".txt")
        appended_path.close()
        try:
            await _save_upload_with_limit(file, appended_path.name, MAX_APPEND_BYTES)
            with open(appended_path.name, "rb") as source, open(tmp_path, "ab") as target:
                while chunk := source.read(1024 * 1024):
                    target.write(chunk)
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=413)
        finally:
            if os.path.exists(appended_path.name):
                os.remove(appended_path.name)

        chapters = parse_chapters_from_file(tmp_path)
        total_chapters = len(chapters)
        is_segmented = _should_segment_book(total_chapters)

        if is_segmented:
            story_id = bookId if bookId else (sanitize_slug(filename.replace(".txt", "")) + "_" + str(int(asyncio.get_event_loop().time())))

            segments = partition_chapters(chapters)
            chapter_counts = []
            story_metadata = {
                "id": story_id,
                "title": filename.replace(".txt", ""),
                "totalChapters": total_chapters,
                "isSegmented": True,
                "segmentFormatVersion": SEGMENT_FORMAT_VERSION,
                "segmentSize": SEGMENT_CHAPTER_SIZE,
                "segmentsCount": len(segments),
                "updatedAt": firestore.SERVER_TIMESTAMP
            }

            for i, seg_chapters in enumerate(segments):
                seg_data = []
                for chap in seg_chapters:
                    sentences = split_text_into_chunks(chap['content'])
                    chapter_counts.append(len(sentences))
                    seg_data.append({"title": chap['title'], "sentences": sentences})

                seg_blob_path = segment_blob_path(userId, story_id, i, SEGMENT_FORMAT_VERSION)
                _upload_json_blob(bucket.blob(seg_blob_path), seg_data)
                del seg_data
                gc.collect()

            story_metadata["chapterCounts"] = chapter_counts
            db_admin.collection("users").document(userId).collection("stories").document(story_id).set(story_metadata, merge=True)

            blob.upload_from_filename(tmp_path)
            _invalidate_legacy_source_cache(userId, filename)
        else:
            blob.upload_from_filename(tmp_path)
            _invalidate_legacy_source_cache(userId, filename)

            story_id = bookId
            if story_id:
                chapters_summary = []
                for chap in chapters:
                    sentences = split_text_into_chunks(chap['content'])
                    chapters_summary.append({"title": chap['title'], "count": len(sentences)})

                db_admin.collection("users").document(userId).collection("stories").document(story_id).set({
                    "id": story_id,
                    "title": filename.replace(".txt", ""),
                    "totalChapters": total_chapters,
                    "chaptersSummary": chapters_summary,
                    "isSegmented": False,
                    "updatedAt": firestore.SERVER_TIMESTAMP
                }, merge=True)

        if story_id:
            toc_counts = chapter_counts if is_segmented else [item["count"] for item in chapters_summary]
            write_toc_cache(userId, story_id, chapters, toc_counts)

        chapters_metadata = []
        for chap in chapters:
            sentences = split_text_into_chunks(chap['content'])
            chapters_metadata.append({
                "title": chap['title'],
                "count": len(sentences)
            })

        return JSONResponse({
            "title": filename.replace(".txt", ""),
            "chapters": chapters_metadata,
            "isSegmented": is_segmented
        })
    except Exception as e:
        logger.error("Error in append_chapter processing: %s", e)
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


@router.post("/api/delete-chapters")
async def delete_chapters(
    request: Request,
    userId: str = Form(...),
    bookId: str = Form(...),
    filename: str = Form(...),
    indices: str = Form(...)
):
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error

    try:
        bucket = storage.bucket()
    except Exception as e:
        return JSONResponse({"error": f"Could not access storage bucket: {e}"}, status_code=500)

    blob_path = f"users/{userId}/files/{filename}"
    blob = bucket.blob(blob_path)

    try:
        target_indices = json.loads(indices)
        if not isinstance(target_indices, list):
            return JSONResponse({"error": "Indices must be a JSON array"}, status_code=400)
        if len(target_indices) > 200:
            return JSONResponse({"error": "Too many chapters selected"}, status_code=413)
        if any(not isinstance(index, int) or isinstance(index, bool) for index in target_indices):
            return JSONResponse({"error": "Indices must contain integers"}, status_code=400)
        target_indices.sort(reverse=True)
    except Exception as e:
        return JSONResponse({"error": f"Invalid indices format: {e}"}, status_code=400)

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".txt")
    tmp_path = tmp.name
    tmp.close()
    try:
        is_recovered = False
        if not blob.exists() and bookId:
            story_ref = db_admin.collection("users").document(userId).collection("stories").document(bookId)
            story_doc = story_ref.get()
            if story_doc.exists:
                meta = story_doc.to_dict()
                if meta.get("isSegmented") and meta.get("segmentsCount"):
                    recovered_text = reconstruct_text_from_segments(
                        userId, bookId, meta["segmentsCount"], int(meta.get("segmentFormatVersion") or 0)
                    )
                    if recovered_text:
                        with open(tmp_path, "w", encoding="utf-8") as f:
                            f.write(recovered_text)
                        is_recovered = True

        if not is_recovered:
            if not blob.exists():
                return JSONResponse({"error": "File not found"}, status_code=404)
            blob.download_to_filename(tmp_path)

        chapters = parse_chapters_from_file(tmp_path)

        for idx in target_indices:
            if 0 <= idx < len(chapters):
                chapters.pop(idx)

        with open(tmp_path, "w", encoding="utf-8") as f:
            for i, chap in enumerate(chapters):
                if i > 0:
                    f.write("\n\n===\n\n")
                f.write(chap['content'])

        blob.upload_from_filename(tmp_path)
        _invalidate_legacy_source_cache(userId, filename)

        total_chapters = len(chapters)
        is_segmented = _should_segment_book(total_chapters)

        if is_segmented:
            segments = partition_chapters(chapters)
            chapter_counts = []
            for i, seg_chapters in enumerate(segments):
                seg_data = []
                for chap in seg_chapters:
                    sentences = split_text_into_chunks(chap['content'])
                    chapter_counts.append(len(sentences))
                    seg_data.append({"title": chap['title'], "sentences": sentences})

                seg_blob_path = segment_blob_path(userId, bookId, i, SEGMENT_FORMAT_VERSION)
                _upload_json_blob(bucket.blob(seg_blob_path), seg_data)
                del seg_data
                gc.collect()

            db_admin.collection("users").document(userId).collection("stories").document(bookId).set({
                "totalChapters": total_chapters,
                "segmentsCount": len(segments),
                "chapterCounts": chapter_counts,
                "isSegmented": True,
                "segmentFormatVersion": SEGMENT_FORMAT_VERSION,
                "segmentSize": SEGMENT_CHAPTER_SIZE,
                "updatedAt": firestore.SERVER_TIMESTAMP
            }, merge=True)
        else:
            chapters_summary = []
            for chap in chapters:
                sentences = split_text_into_chunks(chap['content'])
                chapters_summary.append({"title": chap['title'], "count": len(sentences)})

            db_admin.collection("users").document(userId).collection("stories").document(bookId).set({
                "totalChapters": total_chapters,
                "chaptersSummary": chapters_summary,
                "isSegmented": False,
                "updatedAt": firestore.SERVER_TIMESTAMP
            }, merge=True)

        toc_counts = chapter_counts if is_segmented else [item["count"] for item in chapters_summary]
        write_toc_cache(userId, bookId, chapters, toc_counts)

        chapters_metadata = []
        for chap in chapters:
            sentences = split_text_into_chunks(chap['content'])
            chapters_metadata.append({
                "title": chap['title'],
                "count": len(sentences)
            })

        return JSONResponse({
            "title": filename.replace(".txt", ""),
            "chapters": chapters_metadata
        })
    except Exception as e:
        logger.error("Error in delete_chapters processing: %s", e)
        return JSONResponse({"error": str(e)}, status_code=500)
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


@router.post("/api/get-chapter-content")
async def get_chapter_content(
    request: Request,
    userId: str = Form(...),
    bookId: str = Form(None),
    filename: str = Form(...),
    chapterIndex: int = Form(...)
):
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error

    try:
        bucket = storage.bucket()
        blob_path = f"users/{userId}/files/{filename}"
        blob = bucket.blob(blob_path)

        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".txt")
        tmp_path = tmp.name
        tmp.close()
        try:
            is_recovered = False
            if not blob.exists() and bookId:
                story_ref = db_admin.collection("users").document(userId).collection("stories").document(bookId)
                story_doc = story_ref.get()
                if story_doc.exists:
                    meta = story_doc.to_dict()
                    if meta.get("isSegmented") and meta.get("segmentsCount"):
                        recovered_text = reconstruct_text_from_segments(
                            userId, bookId, meta["segmentsCount"], int(meta.get("segmentFormatVersion") or 0)
                        )
                        if recovered_text:
                            with open(tmp_path, "w", encoding="utf-8") as f:
                                f.write(recovered_text)
                            is_recovered = True

            if not is_recovered:
                if not blob.exists():
                    return JSONResponse({"error": "File not found"}, status_code=404)
                blob.download_to_filename(tmp_path)

            chapters = parse_chapters_from_file(tmp_path)
            if 0 <= chapterIndex < len(chapters):
                return JSONResponse({"content": chapters[chapterIndex]['content']})
            else:
                return JSONResponse({"error": "Chapter index out of range"}, status_code=400)
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.post("/api/update-chapter")
async def update_chapter(
    request: Request,
    userId: str = Form(...),
    bookId: str = Form(...),
    filename: str = Form(...),
    chapterIndex: int = Form(...),
    newContent: str = Form(...)
):
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error
    if len(newContent) > MAX_NEW_CONTENT_CHARS:
        return JSONResponse({
            "error": f"newContent exceeds the {MAX_NEW_CONTENT_CHARS}-character limit"
        }, status_code=413)

    try:
        bucket = storage.bucket()
        blob_path = f"users/{userId}/files/{filename}"
        blob = bucket.blob(blob_path)

        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".txt")
        tmp_path = tmp.name
        tmp.close()
        try:
            is_recovered = False
            if not blob.exists() and bookId:
                story_ref = db_admin.collection("users").document(userId).collection("stories").document(bookId)
                story_doc = story_ref.get()
                if story_doc.exists:
                    meta = story_doc.to_dict()
                    if meta.get("isSegmented") and meta.get("segmentsCount"):
                        recovered_text = reconstruct_text_from_segments(
                            userId, bookId, meta["segmentsCount"], int(meta.get("segmentFormatVersion") or 0)
                        )
                        if recovered_text:
                            with open(tmp_path, "w", encoding="utf-8") as f:
                                f.write(recovered_text)
                            is_recovered = True

            if not is_recovered:
                if not blob.exists():
                    return JSONResponse({"error": "File not found"}, status_code=404)
                blob.download_to_filename(tmp_path)

            chapters = parse_chapters_from_file(tmp_path)
            if 0 <= chapterIndex < len(chapters):
                chapters[chapterIndex]['content'] = newContent

                with open(tmp_path, "w", encoding="utf-8") as f:
                    for i, chap in enumerate(chapters):
                        if i > 0:
                            f.write("\n\n===\n\n")
                        f.write(chap['content'])

                blob.upload_from_filename(tmp_path)
                _invalidate_legacy_source_cache(userId, filename)

                total_chapters = len(chapters)
                is_segmented = _should_segment_book(total_chapters)

                if is_segmented:
                    segments = partition_chapters(chapters)
                    chapter_counts = []

                    for i, seg_chapters in enumerate(segments):
                        seg_data = []
                        for chap in seg_chapters:
                            sentences = split_text_into_chunks(chap['content'])
                            chapter_counts.append(len(sentences))
                            seg_data.append({"title": chap['title'], "sentences": sentences})

                        seg_blob_path = segment_blob_path(userId, bookId, i, SEGMENT_FORMAT_VERSION)
                        _upload_json_blob(bucket.blob(seg_blob_path), seg_data)
                        del seg_data
                        gc.collect()

                    db_admin.collection("users").document(userId).collection("stories").document(bookId).set({
                        "totalChapters": total_chapters,
                        "segmentsCount": len(segments),
                        "chapterCounts": chapter_counts,
                        "isSegmented": True,
                        "segmentFormatVersion": SEGMENT_FORMAT_VERSION,
                        "segmentSize": SEGMENT_CHAPTER_SIZE,
                        "updatedAt": firestore.SERVER_TIMESTAMP
                    }, merge=True)
                else:
                    chapters_summary = []
                    for chap in chapters:
                        sentences = split_text_into_chunks(chap['content'])
                        chapters_summary.append({"title": chap['title'], "count": len(sentences)})

                    db_admin.collection("users").document(userId).collection("stories").document(bookId).set({
                        "totalChapters": total_chapters,
                        "chaptersSummary": chapters_summary,
                        "isSegmented": False,
                        "updatedAt": firestore.SERVER_TIMESTAMP
                    }, merge=True)

                toc_counts = chapter_counts if is_segmented else [item["count"] for item in chapters_summary]
                write_toc_cache(userId, bookId, chapters, toc_counts)

                updated_lines = newContent.split('\n')
                new_title = "Chương không tên"
                for line in updated_lines:
                    if line.strip():
                        new_title = line.strip()
                        break

                sentences = split_text_into_chunks(newContent)
                return JSONResponse({
                    "title": new_title,
                    "count": len(sentences),
                    "sentences": sentences
                })
            else:
                return JSONResponse({"error": "Chapter index out of range"}, status_code=400)
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
