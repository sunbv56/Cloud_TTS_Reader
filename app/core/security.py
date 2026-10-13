import os
import re
import uuid
import time
import asyncio
import logging
from functools import wraps
from fastapi import Request, UploadFile
from fastapi.responses import JSONResponse
from app.core import google_lite as auth  # verify_id_token without firebase-admin

from app.core.config import (
    FIREBASE_CLOCK_SKEW_SECONDS,
    MAX_TTS_TEXT_CHARS,
    ALLOWED_BOOK_EXTENSIONS,
    ALLOWED_BOOK_CONTENT_TYPES,
    IMPORT_RETRY_AFTER_SECONDS,
)
from app.core.database import firebase_admin_initialized

logger = logging.getLogger("cloud_tts_reader")

# Semaphore for serialized import route
_import_semaphore = asyncio.Semaphore(1)


def set_import_semaphore(semaphore: asyncio.Semaphore):
    global _import_semaphore
    _import_semaphore = semaphore


def _request_id(request: Request) -> str:
    """Return a safe correlation id; never expose authentication material."""
    supplied = (request.headers.get("x-request-id") or "").strip()
    if supplied and len(supplied) <= 80 and re.fullmatch(r"[A-Za-z0-9._:-]+", supplied):
        return supplied
    return uuid.uuid4().hex[:16]


def _verify_bearer_token(authorization: str):
    """Return decoded Firebase claims or None for an invalid token."""
    if not firebase_admin_initialized or not (authorization or "").lower().startswith("bearer "):
        return None
    try:
        token = authorization.split(" ", 1)[1].strip()
        return auth.verify_id_token(
            token, clock_skew_seconds=FIREBASE_CLOCK_SKEW_SECONDS
        )
    except Exception:
        return None


def _authorization_error(request: Request, user_id: str):
    """Verify that the Firebase ID token belongs to the requested user."""
    if not firebase_admin_initialized:
        return JSONResponse({"error": "Firebase Admin not initialized"}, status_code=500)

    authorization = request.headers.get("authorization", "")
    if not authorization.lower().startswith("bearer "):
        return JSONResponse({"error": "Authentication required"}, status_code=401)

    try:
        token = authorization.split(" ", 1)[1].strip()
        decoded = auth.verify_id_token(
            token, clock_skew_seconds=FIREBASE_CLOCK_SKEW_SECONDS
        )
        if decoded.get("uid") != user_id:
            return JSONResponse({"error": "Forbidden"}, status_code=403)
    except Exception as exc:
        logger.warning("[Auth] Firebase ID token verification failed: %s: %s", type(exc).__name__, exc)
        return JSONResponse({"error": "Invalid or expired authentication token"}, status_code=401)
    return None


async def _authorization_error_async(request: Request, user_id: str):
    """Keep Firebase token verification off the event loop on hot read routes."""
    return await asyncio.to_thread(_authorization_error, request, user_id)


def _verify_export_owner(request: Request, user_id: str):
    """Verify the Firebase ID token when the export endpoint is called."""
    authorization = request.headers.get("authorization", "")
    if not authorization.lower().startswith("bearer "):
        return JSONResponse({"error": "Authentication required"}, status_code=401)
    try:
        token = authorization.split(" ", 1)[1].strip()
        decoded = auth.verify_id_token(
            token, clock_skew_seconds=FIREBASE_CLOCK_SKEW_SECONDS
        )
        if decoded.get("uid") != user_id:
            return JSONResponse({"error": "Forbidden"}, status_code=403)
    except Exception:
        return JSONResponse({"error": "Invalid or expired authentication token"}, status_code=401)
    return None


def _serialized_import_route(route):
    """Return 429 instead of queueing another RAM-heavy import in the proxy."""
    @wraps(route)
    async def guarded(*args, **kwargs):
        if _import_semaphore.locked():
            return JSONResponse(
                {"error": "Another import is already processing", "retryable": True},
                status_code=429,
                headers={"Retry-After": str(IMPORT_RETRY_AFTER_SECONDS)},
            )
        async with _import_semaphore:
            return await route(*args, **kwargs)
    return guarded


def _validate_text_size(text: str, field_name: str = "text"):
    if not isinstance(text, str) or not text.strip():
        return JSONResponse({"error": f"{field_name} is required"}, status_code=400)
    if len(text) > MAX_TTS_TEXT_CHARS:
        return JSONResponse({
            "error": f"{field_name} exceeds the {MAX_TTS_TEXT_CHARS}-character limit"
        }, status_code=413)
    return None


def _validate_book_upload(upload: UploadFile):
    """Reject uploads outside the supported book formats before parsing them."""
    filename = (upload.filename or "").strip()
    extension = os.path.splitext(filename)[1].lower()
    content_type = (upload.content_type or "").lower().split(";", 1)[0].strip()
    if extension not in ALLOWED_BOOK_EXTENSIONS:
        return JSONResponse({"error": "Only .txt, .epub and .pdf files are supported"}, status_code=415)
    if content_type not in ALLOWED_BOOK_CONTENT_TYPES:
        return JSONResponse({"error": "The uploaded file type is not supported"}, status_code=415)
    return None


def _validate_text_upload(upload: UploadFile):
    """Backward-compatible name for the shared book upload validator."""
    return _validate_book_upload(upload)


def _valid_image_id(image_id: str) -> bool:
    return bool(re.fullmatch(r"img_[A-Za-z0-9_-]{8,80}", image_id or ""))


def _validate_supported_text_encoding(file_path: str):
    """Accept UTF-8/UTF-16 only; reject legacy encodings such as Windows-1258."""
    with open(file_path, "rb") as source:
        raw = source.read()
    try:
        if raw.startswith(b"\xef\xbb\xbf"):
            raw[3:].decode("utf-8")
        elif raw.startswith((b"\xff\xfe", b"\xfe\xff")):
            raw.decode("utf-16")
        else:
            raw.decode("utf-8")
    except UnicodeDecodeError:
        return JSONResponse({
            "error": "Unsupported text encoding. Please save the file as UTF-8 or UTF-16."
        }, status_code=415)
    return None
