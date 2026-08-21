import os
import gc
import json
import uuid
import asyncio
import logging
import tempfile
from typing import List, Optional
from urllib.parse import quote

from fastapi import APIRouter, Request, Response, Form, UploadFile, File, BackgroundTasks, Query
from fastapi.responses import StreamingResponse, JSONResponse
from firebase_admin import firestore

from app.core.config import (
    MAX_UPLOAD_BYTES,
    MAX_APPEND_BYTES,
    MAX_APPEND_CHAPTERS,
    MAX_IMAGE_BYTES,
    MAX_NEW_CONTENT_CHARS,
    SEGMENT_CHAPTER_SIZE,
    SEGMENT_FORMAT_VERSION,
)
from app.core.database import db_admin, storage, firebase_admin_initialized, is_storage_not_found
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


@router.post("/api/upload-story")
@_serialized_import_route
async def upload_story(
    request: Request,
    userId: str = Form(...),
    file: UploadFile = File(...)
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
            "sourceFilename": file.filename,
            "sourceFormat": os.path.splitext(file.filename or "")[1].lower().lstrip(".") or "txt"
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

        await _run_blocking(
            "firestore.write_story_metadata",
            db_admin.collection("users").document(userId).collection("stories").document(story_id).set,
            story_metadata,
            request_id=request_id,
        )

        logger.info("import_completed request_id=%s story_id=%s chapters=%s", request_id, story_id, total_chapters)

        return JSONResponse({
            "status": "ok",
            "storyId": story_id,
            "title": story_title,
            "filename": canonical_filename,
            "isSegmented": story_metadata["isSegmented"],
            "totalChapters": total_chapters,
            "chapters": chapters_summary if not story_metadata["isSegmented"] else [],
            "chaptersSummary": chapters_summary if not story_metadata["isSegmented"] else []
        })
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


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
    manifest_path = _image_manifest_path(userId, storyId)
    blob = storage.bucket().blob(manifest_path)
    req_id = _request_id(request)
    headers = {"X-Storage-Backend": backend_name}

    try:
        exists = await _run_storage(
            "storage.check_image_manifest", blob.exists, request_id=req_id
        )
        if not exists:
            logger.info("image_manifest_not_found story_id=%s user_id=%s path=%s backend=%s req_id=%s",
                        storyId, userId, manifest_path, backend_name, req_id)
            headers["X-Manifest-Found"] = "false"
            return JSONResponse(
                {"version": 1, "coverId": None, "images": [], "_storage_backend": backend_name, "_found": False},
                headers=headers
            )
        raw = await _run_storage(
            "storage.download_image_manifest", blob.download_as_text, request_id=req_id
        )
        data = json.loads(raw)
        if isinstance(data, dict):
            data["_storage_backend"] = backend_name
            data["_found"] = True
        headers["X-Manifest-Found"] = "true"
        return JSONResponse(data, headers=headers)
    except Exception as exc:
        if is_storage_not_found(exc):
            logger.info("image_manifest_storage_not_found story_id=%s path=%s backend=%s req_id=%s",
                        storyId, manifest_path, backend_name, req_id)
            headers["X-Manifest-Found"] = "false"
            return JSONResponse(
                {"version": 1, "coverId": None, "images": [], "_storage_backend": backend_name, "_found": False},
                headers=headers
            )
        if isinstance(exc, (ValueError, json.JSONDecodeError)):
            logger.error("image_manifest_corrupted story_id=%s path=%s error=%s", storyId, manifest_path, exc)
            return JSONResponse({"error": "Image manifest is invalid"}, status_code=502, headers=headers)
        logger.exception("image_manifest_download_failed story_id=%s backend=%s", storyId, backend_name)
        return JSONResponse(
            {"error": f"Image storage unavailable ({backend_name})", "retryable": True},
            status_code=503,
            headers=headers
        )


@router.put("/api/stories/{userId}/{storyId}/images/manifest")
async def put_image_manifest(request: Request, userId: str, storyId: str, manifest: dict):
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error
    if storage is None:
        return JSONResponse({"error": "Storage backend is not configured"}, status_code=503)
    payload = json.dumps(manifest, ensure_ascii=False)
    if len(payload.encode("utf-8")) > 100 * 1024:
        return JSONResponse({"error": "Image manifest is too large"}, status_code=413)
    storage.bucket().blob(_image_manifest_path(userId, storyId)).upload_from_string(
        payload,
        content_type="application/json",
    )
    return JSONResponse({"status": "ok"})


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
    storage.bucket().blob(_image_asset_path(userId, storyId, imageId)).upload_from_string(
        data,
        content_type="image/webp",
    )
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
    return Response(content=data, media_type="image/webp", headers=headers)


@router.delete("/api/stories/{userId}/{storyId}/images/{imageId}")
async def delete_story_image(request: Request, userId: str, storyId: str, imageId: str):
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error
    if storage is None or not _valid_image_id(imageId):
        return JSONResponse({"status": "ok"})
    blob = storage.bucket().blob(_image_asset_path(userId, storyId, imageId))
    if blob.exists():
        blob.delete()
    return JSONResponse({"status": "ok"})


@router.delete("/api/stories/{userId}/{storyId}/images")
async def delete_story_images(request: Request, userId: str, storyId: str):
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error
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
        storage.delete_prefix(f"users/{userId}/stories/{storyId}/")
        storage.delete_prefix(f"users/{userId}/images/{storyId}/")
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
