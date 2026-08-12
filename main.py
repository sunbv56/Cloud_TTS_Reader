import os
from dotenv import load_dotenv
load_dotenv()  # Load variables from .env if it exists

import re
import json
import asyncio
import codecs
import edge_tts
import tempfile
import gc
from ebooklib import epub, ITEM_DOCUMENT
from bs4 import BeautifulSoup
from pypdf import PdfReader
import firebase_admin
from firebase_admin import credentials, storage as firebase_storage, firestore, auth
from storage_adapter import get_storage_backend
from urllib.parse import quote
from fastapi import FastAPI, Request, Response, Form, UploadFile, File, WebSocket, WebSocketDisconnect, Query
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional

# Initialize Firebase Admin
firebase_admin_initialized = False
firebase_creds_json = os.getenv("FIREBASE_SERVICE_ACCOUNT")

if firebase_creds_json:
    try:
        # Strip potential single/double quotes from the beginning and end (common in Fly.io/Docker secrets)
        firebase_creds_json = firebase_creds_json.strip().strip("'").strip('"')
        creds_dict = json.loads(firebase_creds_json)
        cred = credentials.Certificate(creds_dict)
        firebase_admin.initialize_app(cred, {
            'storageBucket': os.getenv("FIREBASE_STORAGE_BUCKET")
        })
        print("Firebase Admin initialized via environment variable.")
        firebase_admin_initialized = True
    except Exception as e:
        print(f"Error initializing Firebase Admin with service account: {e}")
        # Log a snippet of the JSON to help domestic debugging (safely)
        if firebase_creds_json:
            print(f"Creds JSON starts with: {firebase_creds_json[:20]}...")
else:
    # Try default initialization (e.g. if running on GCP/GCE)
    try:
        firebase_admin.initialize_app(options={
            'storageBucket': os.getenv("FIREBASE_STORAGE_BUCKET")
        })
        print("Firebase Admin initialized via default credentials.")
        firebase_admin_initialized = True
    except Exception as e:
        print(f"Warning: Firebase Admin could not be initialized (local dev?). Storage features will be limited: {e}")

try:
    if firebase_admin_initialized:
        db_admin = firestore.client()
    else:
        db_admin = None
except Exception as e:
    print(f"Firestore client could not be initialized: {e}")
    db_admin = None

# Keep the existing bucket/blob interface while allowing the storage provider
# to be switched through STORAGE_BACKEND=b2 without changing Firestore paths.
try:
    storage = get_storage_backend(firebase_storage)
except Exception as e:
    print(f"Storage backend could not be initialized: {e}")
    storage = None

app = FastAPI()
NUM_WORKERS = 3  # Tăng số lượng worker nếu muốn nạp song song nhanh hơn

# Resource limits are intentionally conservative for the 256 MB Fly.io VM. They
# can be raised per deployment through environment variables without changing
# the storage schema or existing user files.
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
MAX_APPEND_BYTES = int(os.getenv("MAX_APPEND_BYTES", str(10 * 1024 * 1024)))
MAX_TTS_TEXT_CHARS = int(os.getenv("MAX_TTS_TEXT_CHARS", "5000"))
MAX_DOWNLOAD_CHAPTERS = int(os.getenv("MAX_DOWNLOAD_CHAPTERS", "50"))
MAX_DOWNLOAD_SENTENCES = int(os.getenv("MAX_DOWNLOAD_SENTENCES", "50000"))
MAX_WS_WORKERS = int(os.getenv("MAX_WS_WORKERS", "5"))
MAX_WS_QUEUE = int(os.getenv("MAX_WS_QUEUE", "100"))
MAX_WS_PER_USER = int(os.getenv("MAX_WS_PER_USER", "2"))
MAX_NEW_CONTENT_CHARS = int(os.getenv("MAX_NEW_CONTENT_CHARS", "1000000"))
TTS_CHUNK_TIMEOUT_SECONDS = float(os.getenv("TTS_CHUNK_TIMEOUT_SECONDS", "30"))
MAX_IMAGE_BYTES = int(os.getenv("MAX_IMAGE_BYTES", str(150 * 1024)))
# Firebase ID tokens are time-bound. A small tolerance keeps local development
# usable when the machine clock drifts by a few seconds, while the OS clock
# should still be synchronized (Firebase Admin accepts at most 60 seconds).
FIREBASE_CLOCK_SKEW_SECONDS = max(
    0, min(60, int(os.getenv("FIREBASE_CLOCK_SKEW_SECONDS", "30")))
)

ALLOWED_BOOK_EXTENSIONS = {".txt", ".epub", ".pdf"}
ALLOWED_BOOK_CONTENT_TYPES = {
    "text/plain", "application/octet-stream", "",
    "application/epub+zip", "application/zip", "application/x-zip-compressed",
    "application/pdf",
}
_active_ws_by_uid = {}
_active_ws_lock = asyncio.Lock()


def _authorization_error(request: Request, user_id: str):
    """Verify that the Firebase ID token belongs to the requested user."""
    if not firebase_admin_initialized:
        return JSONResponse({"error": "Firebase Admin not initialized"}, status_code=500)

    authorization = request.headers.get("authorization", "")
    if not authorization.lower().startswith("bearer "):
        return JSONResponse({"error": "Authentication required"}, status_code=401)

    try:
        token = authorization.split(" ", 1)[1].strip()
        # Equivalent to auth.verify_id_token(token), with bounded clock skew.
        decoded = auth.verify_id_token(
            token, clock_skew_seconds=FIREBASE_CLOCK_SKEW_SECONDS
        )
        if decoded.get("uid") != user_id:
            return JSONResponse({"error": "Forbidden"}, status_code=403)
    except Exception as exc:
        # Never log the bearer token. The exception type/message is enough to
        # distinguish an expired token from a project, clock, or network issue.
        print(f"[Auth] Firebase ID token verification failed: {type(exc).__name__}: {exc}")
        return JSONResponse({"error": "Invalid or expired authentication token"}, status_code=401)
    return None


def _verify_bearer_token(authorization: str):
    """Return decoded Firebase claims or None for an invalid token."""
    if not firebase_admin_initialized or not authorization.lower().startswith("bearer "):
        return None
    try:
        token = authorization.split(" ", 1)[1].strip()
        return auth.verify_id_token(
            token, clock_skew_seconds=FIREBASE_CLOCK_SKEW_SECONDS
        )
    except Exception:
        return None


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


def _image_asset_path(user_id: str, story_id: str, image_id: str) -> str:
    return f"users/{user_id}/images/{story_id}/assets/{image_id}.webp"


def _image_manifest_path(user_id: str, story_id: str) -> str:
    return f"users/{user_id}/images/{story_id}/manifest.json"


def _detect_text_encoding(file_path: str):
    """Detect the supported Unicode TXT encodings without loading the full file."""
    with open(file_path, "rb") as source:
        prefix = source.read(4)
        sample = prefix + source.read(64 * 1024)
    if sample.startswith(b"\xef\xbb\xbf"):
        return "utf-8-sig"
    if sample.startswith((b"\xff\xfe", b"\xfe\xff")):
        return "utf-16"
    # The sample can end halfway through a multi-byte UTF-8 character (for
    # example when a Vietnamese character crosses the 64 KiB boundary). An
    # incremental decoder accepts that incomplete trailing sequence while
    # still rejecting invalid bytes in the middle of the sample.
    codecs.getincrementaldecoder("utf-8")().decode(sample, final=False)
    return "utf-8"


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


async def _iter_tts_chunks(communicate):
    """Yield TTS chunks while bounding every upstream read."""
    stream = communicate.stream().__aiter__()
    while True:
        try:
            chunk = await asyncio.wait_for(
                stream.__anext__(), timeout=TTS_CHUNK_TIMEOUT_SECONDS
            )
        except StopAsyncIteration:
            return
        yield chunk


async def _save_upload_with_limit(upload: UploadFile, target_path: str, max_bytes: int):
    """Stream an upload to disk and reject it before it can exhaust memory/disk."""
    total = 0
    try:
        with open(target_path, "wb") as target:
            while chunk := await upload.read(1024 * 1024):
                total += len(chunk)
                if total > max_bytes:
                    raise ValueError(f"File exceeds the {max_bytes} byte limit")
                target.write(chunk)
    except ValueError:
        if os.path.exists(target_path):
            os.remove(target_path)
        raise
    return total

def sanitize_slug(text: str):
    """Convert Vietnamese text to clean ASCII slug."""
    # Convert to lowercase
    text = text.lower()
    
    # Vietnamese character mapping
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
    
    # Remove special characters, keep only a-z, 0-9 and spaces
    text = re.sub(r'[^a-z0-9\s-]', '', text)
    
    # Replace spaces with single dash
    text = re.sub(r'\s+', '-', text).strip('-')
    
    # Remove multiple dashes
    text = re.sub(r'-+', '-', text)
    
    return text

# Mount static files
static_dir = os.path.join(os.path.dirname(__file__), "static")
if not os.path.exists(static_dir):
    os.makedirs(static_dir)

# Helper functions for book parsing
def parse_chapters_from_file(file_path: str):
    """Memory-efficient chapter parsing by reading file line by line."""
    chapters = []
    current_raw_lines = []
    
    def process_raw_chapter(raw_lines):
        if not raw_lines: return
        raw_text = "".join(raw_lines).strip()
        if not raw_text: return
        
        lines = raw_text.split('\n')
        title = "Chương không tên"
        for line in lines:
            if line.strip():
                title = line.strip()
                break
        chapters.append({'title': title, 'content': raw_text})

    encoding = _detect_text_encoding(file_path)
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
    
    # Handle empty case
    if not chapters:
        # Check if file has any content
        with open(file_path, 'r', encoding=encoding, errors='replace') as f:
            full_text = f.read(1000).strip() # just a peek
            if full_text:
                # If no delimiters found, treat entire file as one chapter
                with open(file_path, 'r', encoding=encoding, errors='replace') as f2:
                    content = f2.read().strip()
                    if content:
                        chapters.append({'title': "Mở đầu", 'content': content})
    return chapters


def _chapter_from_text(text: str, fallback_title: str):
    """Normalize one imported document fragment into the reader chapter shape."""
    content = re.sub(r'\n{3,}', '\n\n', text or '').strip()
    if not content:
        return None
    title = next((line.strip() for line in content.splitlines() if line.strip()), fallback_title)
    return {"title": title[:300], "content": content}


def parse_epub_chapters(file_path: str):
    book = epub.read_epub(file_path, options={"ignore_ncx": False})
    chapters = []
    for item in book.get_items_of_type(ITEM_DOCUMENT):
        soup = BeautifulSoup(item.get_content(), "html.parser")
        for node in soup(["script", "style", "nav"]):
            node.decompose()
        text = soup.get_text("\n", strip=True)
        chapter = _chapter_from_text(text, f"Chương {len(chapters) + 1}")
        if chapter:
            chapters.append(chapter)
    return chapters


def parse_pdf_chapters(file_path: str):
    reader = PdfReader(file_path)
    if reader.is_encrypted:
        raise ValueError("PDF is encrypted or password protected")
    chapters = []
    for page_number, page in enumerate(reader.pages, start=1):
        chapter = _chapter_from_text(page.extract_text() or "", f"Trang {page_number}")
        if chapter:
            chapters.append(chapter)
    if not chapters:
        raise ValueError("PDF has no extractable text. Scanned PDFs are not supported yet.")
    return chapters


def parse_book_file(file_path: str, filename: str):
    """Parse TXT, EPUB or text-based PDF into the canonical chapter format."""
    extension = os.path.splitext(filename or file_path)[1].lower()
    if extension == ".txt":
        return parse_chapters_from_file(file_path)
    if extension == ".epub":
        return parse_epub_chapters(file_path)
    if extension == ".pdf":
        return parse_pdf_chapters(file_path)
    raise ValueError("Unsupported book format")


def write_canonical_text(file_path: str, chapters: List[dict]):
    """Persist every format as UTF-8 text so edit/export flows stay format-agnostic."""
    with open(file_path, "w", encoding="utf-8") as target:
        for index, chapter in enumerate(chapters):
            if index:
                target.write("\n\n===\n\n")
            target.write((chapter.get("content") or "").strip())

def split_text_into_chunks(text: str, max_chars: int = 500):
    chunks = []
    # Optimization: Use splitlines() to avoid unnecessary string copies
    for line in text.splitlines():
        line = line.strip()
        if not line: continue
        if len(line) <= max_chars:
            chunks.append(line)
        else:
            # Keep regex for sentence splitting
            sentences = re.split(r'(?<=[.!?])\s+', line)
            temp_chunk = ""
            for sentence in sentences:
                if len(temp_chunk) + len(sentence) > max_chars:
                    if temp_chunk: chunks.append(temp_chunk.strip())
                    temp_chunk = sentence
                else:
                    temp_chunk += " " + sentence if temp_chunk else sentence
            if temp_chunk: chunks.append(temp_chunk.strip())
    
    # Optimization: Use regex search instead of manual iteration for alphanumeric check
    alnum_regex = re.compile(r'\w')
    valid_chunks = [c for c in chunks if alnum_regex.search(c)]
    return valid_chunks

def partition_chapters(chapters: List[dict], segment_size: int = 100):
    """Partition chapters into segments of 100."""
    segments = []
    for i in range(0, len(chapters), segment_size):
        segment = chapters[i : i + segment_size]
        segments.append(segment)
    return segments

def reconstruct_text_from_segments(userId: str, story_id: str, segments_count: int):
    """
    Reconstruct full text from JSON segments if the master .txt is missing.
    Ensures '===' separators are restored between chapters.
    Uses parallel downloading for speed while maintaining order.
    """
    bucket = storage.bucket()
    # Download segments sequentially to save RAM on 256MB servers
    results = {}
    for i in range(segments_count):
        blob_path = f"users/{userId}/stories/{story_id}/segments/seg_{i}.json"
        blob = bucket.blob(blob_path)
        if blob.exists():
            try:
                print(f"[Recovery] Downloading segment {i}/{segments_count-1}...")
                data = json.loads(blob.download_as_text())
                seg_text = ""
                for chapter in data:
                    chapter_text = chapter['title'] + "\n" + "\n".join(chapter['sentences'])
                    if seg_text:
                        seg_text += "\n\n===\n\n"
                    seg_text += chapter_text
                results[i] = seg_text
                # Cleanup local variables
                del data
                gc.collect()
            except Exception as e:
                print(f"[Recovery] Error downloading segment {i}: {e}")
        else:
            results[i] = ""
            
    # Combine in strict order
    full_text = ""
    for i in range(segments_count):
        if results.get(i):
            if full_text:
                full_text += "\n\n===\n\n"
            full_text += results[i]
            
    return full_text

def _safe_export_filename(metadata: dict, story_id: str) -> str:
    """Return a filesystem-safe UTF-8 filename for text exports."""
    raw_name = metadata.get("filename") or metadata.get("title") or story_id
    raw_name = os.path.basename(str(raw_name)).strip() or story_id
    if not raw_name.lower().endswith(".txt"):
        raw_name += ".txt"
    # Keep Unicode letters (including Vietnamese) while removing Windows-invalid
    # path characters and control characters.
    raw_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", raw_name)
    return raw_name[:180]

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

def convert_firestore_data(data: dict):
    """Convert Firestore-specific types (like DatetimeWithNanoseconds) to JSON serializable formats."""
    if not data:
        return data
    for key, value in data.items():
        # Handle Firestore Timestamps
        if hasattr(value, 'isoformat'):
            data[key] = value.isoformat()
        elif isinstance(value, list):
            data[key] = [convert_firestore_data(i) if isinstance(i, dict) else i for i in value]
        elif isinstance(value, dict):
            data[key] = convert_firestore_data(value)
    return data

# API Endpoints
@app.get("/stream/audio")
async def stream_audio(request: Request, text: str, voice: str, rate: str = "+0%", pitch: str = "+0Hz", volume: str = "+0%"):
    if _verify_bearer_token(request.headers.get("authorization", "")) is None:
        return JSONResponse({"error": "Authentication required"}, status_code=401)
    text_error = _validate_text_size(text)
    if text_error:
        return text_error
    # Format settings for edge-tts
    # rate: +50%, -10%, etc.
    # pitch: +5Hz, -5Hz, etc.
    # volume: +10%, -10%, etc.
    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, volume=volume)
    
    async def audio_generator():
        async for chunk in _iter_tts_chunks(communicate):
            if chunk["type"] == "audio":
                yield chunk["data"]
    
    return StreamingResponse(audio_generator(), media_type="audio/mpeg")

@app.get("/stream/metadata")
async def stream_metadata(request: Request, text: str, voice: str, rate: str = "+0%", pitch: str = "+0Hz", volume: str = "+0%"):
    if _verify_bearer_token(request.headers.get("authorization", "")) is None:
        return JSONResponse({"error": "Authentication required"}, status_code=401)
    text_error = _validate_text_size(text)
    if text_error:
        return text_error
    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, volume=volume)
    metadata = []
    async for chunk in _iter_tts_chunks(communicate):
        if chunk["type"] == "WordBoundary":
            metadata.append({
                "start": chunk["offset"] / 10_000_000, # Convert 100ns to seconds
                "duration": chunk["duration"] / 10_000_000,
                "text": chunk["text"]
            })
    return JSONResponse(metadata)

@app.post("/api/parse-book")
async def parse_book(file: UploadFile = File(...)):
    upload_error = _validate_text_upload(file)
    if upload_error:
        return upload_error
    # Memory optimization: Stream upload to a temporary file
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
            chapters = parse_book_file(tmp_path, file.filename)
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=422)
        
        # Optimization: Generate metadata in a single pass and remove redundant processed_chapters loop
        chapters_metadata = []
        for chap in chapters:
            sentences = split_text_into_chunks(chap['content'])
            chapters_metadata.append({
                "title": chap['title'],
                "count": len(sentences)
            })

        return JSONResponse({
            "title": os.path.splitext(file.filename or "book")[0],
            "chapters": chapters_metadata
        })
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

@app.post("/api/upload-story")
async def upload_story(
    request: Request,
    userId: str = Form(...),
    file: UploadFile = File(...)
):
    """
    Advanced upload with chunking logic.
    If chapters > 200, splits into 100-chapter segments.
    """
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error
    upload_error = _validate_text_upload(file)
    if upload_error:
        return upload_error

    # Sanitize title
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
            chapters = parse_book_file(tmp_path, file.filename)
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=422)
        total_chapters = len(chapters)
        canonical_filename = f"{story_id}.txt"
        write_canonical_text(tmp_path, chapters)
        
        # Metadata for Firestore
        story_metadata = {
            "id": story_id,
            "title": story_title,
            "totalChapters": total_chapters,
            "isSegmented": total_chapters > 200,
            "createdAt": firestore.SERVER_TIMESTAMP,
            "filename": canonical_filename,
            "sourceFilename": file.filename,
            "sourceFormat": os.path.splitext(file.filename or "")[1].lower().lstrip(".") or "txt"
        }

        bucket = storage.bucket()
        
        # ── 1. Always upload the master .txt file (used for future appends/edits) ──
        master_blob_path = f"users/{userId}/files/{canonical_filename}"
        master_blob = bucket.blob(master_blob_path)
        master_blob.upload_from_filename(tmp_path)
        story_metadata["masterPath"] = master_blob_path
        
        if story_metadata["isSegmented"]:
            segments = partition_chapters(chapters)
            story_metadata["segmentsCount"] = len(segments)
            chapter_counts = []  # Collect per-chapter counts for accurate global index
            
            # Sequential upload to save RAM on 256MB servers (Fly.io)
            for i, seg_chapters in enumerate(segments):
                print(f"[Upload] Processing segment {i}/{len(segments)-1}...")
                seg_data = []
                for chap in seg_chapters:
                    sentences = split_text_into_chunks(chap['content'])
                    chapter_counts.append(len(sentences))  # Store count before cleanup
                    seg_data.append({
                        "title": chap['title'],
                        "sentences": sentences
                    })
                
                seg_blob_path = f"users/{userId}/stories/{story_id}/segments/seg_{i}.json"
                blob = bucket.blob(seg_blob_path)
                blob.upload_from_string(json.dumps(seg_data), content_type="application/json")
                
                # Critical Memory Cleanup
                del seg_data
                gc.collect()
            story_metadata["chapterCounts"] = chapter_counts
        else:
            # Traditional upload metadata
            # Store chapter titles/counts in metadata for TOC
            chapters_summary = []
            for chap in chapters:
                sentences = split_text_into_chunks(chap['content'])
                chapters_summary.append({
                    "title": chap['title'],
                    "count": len(sentences)
                })
            story_metadata["chaptersSummary"] = chapters_summary

        # Save metadata to Firestore
        db_admin.collection("users").document(userId).collection("stories").document(story_id).set(story_metadata)

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

@app.post("/api/parse-import")
async def parse_import(
    request: Request,
    userId: str = Form(...),
    file: UploadFile = File(...)
):
    """Return editable chapter preview without modifying a book."""
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error
    upload_error = _validate_book_upload(file)
    if upload_error:
        return upload_error
    suffix = os.path.splitext(file.filename or "")[1] or ".tmp"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp_path = tmp.name
    try:
        await _save_upload_with_limit(file, tmp_path, MAX_APPEND_BYTES)
        if suffix.lower() == ".txt":
            encoding_error = _validate_supported_text_encoding(tmp_path)
            if encoding_error:
                return encoding_error
        chapters = parse_book_file(tmp_path, file.filename)
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


async def _append_prepared_chapters(user_id: str, book_id: str, filename: str, additions: List[dict]):
    """Append already-reviewed chapters and refresh the same storage metadata as TXT append."""
    bucket = storage.bucket()
    blob = bucket.blob(f"users/{user_id}/files/{filename}")
    if not blob.exists():
        return None, JSONResponse({"error": "File not found"}, status_code=404)
    with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as tmp:
        tmp_path = tmp.name
    try:
        blob.download_to_filename(tmp_path)
        chapters = parse_chapters_from_file(tmp_path)
        chapters.extend(additions)
        write_canonical_text(tmp_path, chapters)
        blob.upload_from_filename(tmp_path)
        total_chapters = len(chapters)
        story_ref = db_admin.collection("users").document(user_id).collection("stories").document(book_id)
        is_segmented = total_chapters > 200
        metadata = {"totalChapters": total_chapters, "isSegmented": is_segmented, "updatedAt": firestore.SERVER_TIMESTAMP}
        if is_segmented:
            chapter_counts = []
            segments = partition_chapters(chapters)
            for index, segment in enumerate(segments):
                data = []
                for chapter in segment:
                    sentences = split_text_into_chunks(chapter["content"])
                    chapter_counts.append(len(sentences))
                    data.append({"title": chapter["title"], "sentences": sentences})
                bucket.blob(f"users/{user_id}/stories/{book_id}/segments/seg_{index}.json").upload_from_string(json.dumps(data), content_type="application/json")
            metadata.update({"segmentsCount": len(segments), "chapterCounts": chapter_counts})
        else:
            summary = [{"title": chapter["title"], "count": len(split_text_into_chunks(chapter["content"]))} for chapter in chapters]
            metadata["chaptersSummary"] = summary
        story_ref.set(metadata, merge=True)
        response_chapters = [{"title": chapter["title"], "count": len(split_text_into_chunks(chapter["content"]))} for chapter in chapters]
        return {"title": filename.replace(".txt", ""), "filename": filename, "chapters": response_chapters, "totalChapters": total_chapters, "isSegmented": is_segmented}, None
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


@app.post("/api/append-chapters")
async def append_chapters(
    request: Request,
    userId: str = Form(...),
    bookId: str = Form(...),
    filename: str = Form(...),
    chapters: str = Form(...)
):
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error
    try:
        raw_chapters = json.loads(chapters)
        if not isinstance(raw_chapters, list) or not raw_chapters:
            raise ValueError("At least one chapter is required")
        if len(raw_chapters) > 200:
            raise ValueError("Too many chapters selected")
        additions = []
        for raw in raw_chapters:
            if not isinstance(raw, dict):
                raise ValueError("Invalid chapter format")
            chapter = _chapter_from_text(str(raw.get("content") or ""), str(raw.get("title") or "Chương không tên"))
            if chapter:
                additions.append(chapter)
        if not additions:
            raise ValueError("No non-empty chapters selected")
    except (ValueError, json.JSONDecodeError) as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    result, error = await _append_prepared_chapters(userId, bookId, filename, additions)
    return error or JSONResponse(result)


@app.get("/api/stories/{userId}/{storyId}/metadata")
async def get_story_metadata(request: Request, userId: str, storyId: str):
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error
    
    doc_ref = db_admin.collection("users").document(userId).collection("stories").document(storyId)
    doc = doc_ref.get()
    if not doc.exists:
        return JSONResponse({"error": "Story not found"}, status_code=404)
    
    return JSONResponse(convert_firestore_data(doc.to_dict()))

@app.get("/api/stories/{userId}/{storyId}/segments/{segmentIndex}")
async def get_segment_data(request: Request, userId: str, storyId: str, segmentIndex: int):
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error
    
    bucket = storage.bucket()
    blob_path = f"users/{userId}/stories/{storyId}/segments/seg_{segmentIndex}.json"
    blob = bucket.blob(blob_path)
    
    if not blob.exists():
        return JSONResponse({"error": "Segment not found"}, status_code=404)
    
    data = json.loads(blob.download_as_text())
    return JSONResponse({"chapters": data})


@app.get("/api/stories/{userId}/{storyId}/images/manifest")
async def get_image_manifest(request: Request, userId: str, storyId: str):
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error
    if storage is None:
        return JSONResponse({"error": "Storage backend is not configured"}, status_code=503)
    blob = storage.bucket().blob(_image_manifest_path(userId, storyId))
    if not blob.exists():
        return JSONResponse({"version": 1, "coverId": None, "images": []})
    try:
        return JSONResponse(json.loads(blob.download_as_text()))
    except (ValueError, json.JSONDecodeError):
        return JSONResponse({"error": "Image manifest is invalid"}, status_code=502)


@app.put("/api/stories/{userId}/{storyId}/images/manifest")
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


@app.post("/api/stories/{userId}/{storyId}/images")
async def upload_story_image(
    request: Request,
    userId: str,
    storyId: str,
    imageId: str = Form(...),
    file: UploadFile = File(...),
):
    return await _save_image_object(request, userId, storyId, imageId, file)


@app.put("/api/stories/{userId}/{storyId}/images/{imageId}")
async def replace_story_image(
    request: Request,
    userId: str,
    storyId: str,
    imageId: str,
    file: UploadFile = File(...),
):
    return await _save_image_object(request, userId, storyId, imageId, file)


@app.get("/api/stories/{userId}/{storyId}/images/{imageId}")
async def get_story_image(request: Request, userId: str, storyId: str, imageId: str):
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error
    if storage is None or not _valid_image_id(imageId):
        return JSONResponse({"error": "Image not found"}, status_code=404)
    blob = storage.bucket().blob(_image_asset_path(userId, storyId, imageId))
    if not blob.exists():
        return JSONResponse({"error": "Image not found"}, status_code=404)
    return Response(content=blob.download_as_bytes(), media_type="image/webp")


@app.delete("/api/stories/{userId}/{storyId}/images/{imageId}")
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


@app.delete("/api/stories/{userId}/{storyId}/images")
async def delete_story_images(request: Request, userId: str, storyId: str):
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error
    if storage is not None:
        storage.delete_prefix(f"users/{userId}/images/{storyId}/")
    return JSONResponse({"status": "ok"})


@app.get("/api/stories/{userId}/{storyId}/file")
async def get_story_file(request: Request, userId: str, storyId: str, filename: str = Query(...)):
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error
    if storage is None:
        return JSONResponse({"error": "Storage backend is not configured"}, status_code=503)
    blob = storage.bucket().blob(f"users/{userId}/files/{filename}")
    if not blob.exists():
        return JSONResponse({"error": "File not found"}, status_code=404)
    return Response(content=blob.download_as_bytes(), media_type="text/plain")


@app.delete("/api/stories/{userId}/{storyId}/storage")
async def delete_story_storage(request: Request, userId: str, storyId: str, filename: Optional[str] = Query(None)):
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error
    if storage is not None:
        if filename:
            file_blob = storage.bucket().blob(f"users/{userId}/files/{filename}")
            if file_blob.exists():
                file_blob.delete()
        storage.delete_prefix(f"users/{userId}/stories/{storyId}/")
        storage.delete_prefix(f"users/{userId}/images/{storyId}/")
    return JSONResponse({"status": "ok"})

@app.get("/api/stories/{userId}/{storyId}/export-text")
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
    filename = _safe_export_filename(metadata, storyId)
    bucket = storage.bucket()
    master_path = metadata.get("masterPath") or f"users/{userId}/files/{metadata.get('filename', filename)}"
    master_blob = bucket.blob(master_path)

    if master_blob.exists():
        # Download to a temporary file so the response can stream without keeping
        # the entire book in server memory.
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

    # Validate every required segment before sending response headers. This avoids
    # producing a partial, silently truncated TXT when one segment is missing.
    segment_blobs = []
    for segment_index in range(segments_count):
        blob = bucket.blob(f"users/{userId}/stories/{storyId}/segments/seg_{segment_index}.json")
        if not blob.exists():
            return JSONResponse({
                "error": "Book segments are incomplete",
                "missingSegment": segment_index
            }, status_code=409)
        segment_blobs.append(blob)

    # Validate JSON before sending headers. A malformed segment should produce a
    # clear error response instead of a partially downloaded TXT file.
    for segment_index, blob in enumerate(segment_blobs):
        try:
            json.loads(blob.download_as_text())
        except Exception as exc:
            print(f"[Export] Invalid segment {segment_index}: {exc}")
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
            print(f"[Export] Segment reconstruction failed: {exc}")

    headers = {
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
        "X-Export-Source": "reconstructed"
    }
    return StreamingResponse(reconstructed_stream(), media_type="text/plain; charset=utf-8", headers=headers)

@app.post("/api/get-chapter-sentences")
async def get_chapter_sentences(
    request: Request,
    userId: str = Form(...),
    filename: str = Form(...),
    chapterIndex: int = Form(...)
):
    """Memory-efficiently fetch sentences for a specific chapter only."""
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error

    try:
        bucket = storage.bucket()
        blob_path = f"users/{userId}/files/{filename}"
        blob = bucket.blob(blob_path)
        
        if not blob.exists():
            return JSONResponse({"error": "File not found"}, status_code=404)

        with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as tmp:
            tmp_path = tmp.name
            blob.download_to_filename(tmp_path)
        
        try:
            chapters = parse_chapters_from_file(tmp_path)
            if 0 <= chapterIndex < len(chapters):
                sentences = split_text_into_chunks(chapters[chapterIndex]['content'])
                return JSONResponse({"sentences": sentences})
            else:
                return JSONResponse({"error": "Chapter index out of range"}, status_code=400)
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

@app.get("/api/firebase-config")
async def get_firebase_config():
    # Helper to get env but strip potential quotes
    def get_env_safe(key):
        val = os.getenv(key, "")
        if val:
            return val.strip().strip("'").strip('"')
        return ""

    return {
        "apiKey": get_env_safe("FIREBASE_API_KEY"),
        "authDomain": get_env_safe("FIREBASE_AUTH_DOMAIN"),
        "projectId": get_env_safe("FIREBASE_PROJECT_ID"),
        "storageBucket": get_env_safe("FIREBASE_STORAGE_BUCKET"),
        "messagingSenderId": get_env_safe("FIREBASE_MESSAGING_SENDER_ID"),
        "appId": get_env_safe("FIREBASE_APP_ID"),
        "measurementId": get_env_safe("FIREBASE_MEASUREMENT_ID")
    }

@app.post("/api/append-chapter")
async def append_chapter(
    request: Request,
    userId: str = Form(...),
    bookId: str = Form(...),
    filename: str = Form(...),
    file: UploadFile = File(...)
):
    """Memory-efficient chapter appending on the server."""
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error

    try:
        bucket = storage.bucket()
    except Exception as e:
        return JSONResponse({"error": f"Could not access storage bucket: {e}"}, status_code=500)

    blob_path = f"users/{userId}/files/{filename}"
    blob = bucket.blob(blob_path)

    with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as tmp:
        tmp_path = tmp.name
        try:
            # 1. Check if we need to recover text from segments (for already split books missing master .txt)
            is_recovered = False
            if not blob.exists() and bookId:
                story_ref = db_admin.collection("users").document(userId).collection("stories").document(bookId)
                story_doc = story_ref.get()
                if story_doc.exists:
                    meta = story_doc.to_dict()
                    if meta.get("isSegmented") and meta.get("segmentsCount"):
                        print(f"[Append] Source .txt missing but segments found for {bookId}. Reconstructing...")
                        recovered_text = reconstruct_text_from_segments(userId, bookId, meta["segmentsCount"])
                        if recovered_text:
                            with open(tmp_path, "w", encoding="utf-8") as f:
                                f.write(recovered_text + "\n\n")
                            is_recovered = True

            # 2. Download existing .txt if it exists (traditional or newly uploaded segmented)
            if not is_recovered and blob.exists():
                blob.download_to_filename(tmp_path)
                # Ensure there's a newline separator
                with open(tmp_path, "a", encoding="utf-8") as f:
                    f.write("\n\n")
            
            # 3. Append new content
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
                    
            # 4. Parse result
            chapters = parse_chapters_from_file(tmp_path)
            total_chapters = len(chapters)
            is_segmented = total_chapters > 200

            # 5. Handle Segmentation Transition
            if is_segmented:
                # If it's becoming segmented or already is, we use the story_id structure
                story_id = bookId if bookId else (sanitize_slug(filename.replace(".txt", "")) + "_" + str(int(asyncio.get_event_loop().time())))
                
                segments = partition_chapters(chapters)
                chapter_counts = []  # Collect per-chapter counts
                story_metadata = {
                    "id": story_id,
                    "title": filename.replace(".txt", ""),
                    "totalChapters": total_chapters,
                    "isSegmented": True,
                    "segmentsCount": len(segments),
                    "updatedAt": firestore.SERVER_TIMESTAMP
                }

                # Sequential segment upload to prevent OOM
                for i, seg_chapters in enumerate(segments):
                    print(f"[Append] Syncing segment {i}/{len(segments)-1}...")
                    seg_data = []
                    for chap in seg_chapters:
                        sentences = split_text_into_chunks(chap['content'])
                        chapter_counts.append(len(sentences))  # Store count before cleanup
                        seg_data.append({"title": chap['title'], "sentences": sentences})
                    
                    seg_blob_path = f"users/{userId}/stories/{story_id}/segments/seg_{i}.json"
                    bucket.blob(seg_blob_path).upload_from_string(json.dumps(seg_data), content_type="application/json")
                    
                    # Memory cleanup
                    del seg_data
                    gc.collect()
                
                story_metadata["chapterCounts"] = chapter_counts
                # Update Firestore
                db_admin.collection("users").document(userId).collection("stories").document(story_id).set(story_metadata, merge=True)
                
                # Also upload the updated .txt for future appends
                blob.upload_from_filename(tmp_path)
            else:
                # 6. Traditional Re-upload
                blob.upload_from_filename(tmp_path)
                
                # Update Firestore metadata even for non-segmented
                story_id = bookId
                if story_id:
                    chapters_summary = []
                    for chap in chapters:
                        sentences = split_text_into_chunks(chap['content'])
                        chapters_summary.append({"title": chap['title'], "count": len(sentences)})
                    
                    # Use .set(merge=True) instead of .update() to avoid 404 if document is missing in 'stories'
                    db_admin.collection("users").document(userId).collection("stories").document(story_id).set({
                        "id": story_id,
                        "title": filename.replace(".txt", ""),
                        "totalChapters": total_chapters,
                        "chaptersSummary": chapters_summary,
                        "isSegmented": False,
                        "updatedAt": firestore.SERVER_TIMESTAMP
                    }, merge=True)

            # Re-generate summary for the frontend response
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
            print(f"Error in append_chapter processing: {e}")
            return JSONResponse({"error": str(e)}, status_code=500)
        finally:
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except:
                    pass

@app.post("/api/delete-chapters")
async def delete_chapters(
    request: Request,
    userId: str = Form(...),
    bookId: str = Form(...),
    filename: str = Form(...),
    indices: str = Form(...) # JSON string of list of ints [0, 2, 5]
):
    """Memory-efficient multi-chapter deletion on the server."""
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
        # Sort descending so we can pop without shifting remaining target indices
        target_indices.sort(reverse=True)
    except Exception as e:
        return JSONResponse({"error": f"Invalid indices format: {e}"}, status_code=400)

    with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as tmp:
        tmp_path = tmp.name
        try:
            # 1. Check if we need to recover text from segments
            is_recovered = False
            if not blob.exists() and bookId:
                story_ref = db_admin.collection("users").document(userId).collection("stories").document(bookId)
                story_doc = story_ref.get()
                if story_doc.exists:
                    meta = story_doc.to_dict()
                    if meta.get("isSegmented") and meta.get("segmentsCount"):
                        print(f"[Delete] Source .txt missing but segments found for {bookId}. Reconstructing...")
                        recovered_text = reconstruct_text_from_segments(userId, bookId, meta["segmentsCount"])
                        if recovered_text:
                            with open(tmp_path, "w", encoding="utf-8") as f:
                                f.write(recovered_text)
                            is_recovered = True

            if not is_recovered:
                if not blob.exists():
                    return JSONResponse({"error": "File not found"}, status_code=404)
                blob.download_to_filename(tmp_path)
            
            # 2. Parse into chapters
            chapters = parse_chapters_from_file(tmp_path)
            
            # 3. Remove chapters
            for idx in target_indices:
                if 0 <= idx < len(chapters):
                    chapters.pop(idx)
                else:
                    print(f"Warning: Index {idx} out of range for deletion.")
            
            # 4. Reconstruct file
            with open(tmp_path, "w", encoding="utf-8") as f:
                for i, chap in enumerate(chapters):
                    if i > 0:
                        f.write("\n\n===\n\n")
                    f.write(chap['content'])
                    
            # 5. Re-upload master .txt
            blob.upload_from_filename(tmp_path)
            
            # ── SYNC SEGMENTS IF NEEDED ──
            total_chapters = len(chapters)
            is_segmented = total_chapters > 200
            
            if is_segmented:
                segments = partition_chapters(chapters)
                chapter_counts = []  # Collect per-chapter counts
                
                # Sequential segment upload to prevent OOM
                for i, seg_chapters in enumerate(segments):
                    print(f"[Delete] Syncing segment {i}/{len(segments)-1}...")
                    seg_data = []
                    for chap in seg_chapters:
                        sentences = split_text_into_chunks(chap['content'])
                        chapter_counts.append(len(sentences))  # Store count before cleanup
                        seg_data.append({"title": chap['title'], "sentences": sentences})
                    
                    seg_blob_path = f"users/{userId}/stories/{bookId}/segments/seg_{i}.json"
                    bucket.blob(seg_blob_path).upload_from_string(json.dumps(seg_data), content_type="application/json")
                    
                    # Memory cleanup
                    del seg_data
                    gc.collect()
                
                # Update Firestore
                db_admin.collection("users").document(userId).collection("stories").document(bookId).set({
                    "totalChapters": total_chapters,
                    "segmentsCount": len(segments),
                    "chapterCounts": chapter_counts,
                    "isSegmented": True,
                    "updatedAt": firestore.SERVER_TIMESTAMP
                }, merge=True)
            else:
                # Update chaptersSummary in Firestore
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
            print(f"Error in delete_chapters processing: {e}")
            return JSONResponse({"error": str(e)}, status_code=500)
        finally:
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except:
                    pass

@app.post("/api/get-chapter-content")
async def get_chapter_content(
    request: Request,
    userId: str = Form(...),
    bookId: str = Form(None),
    filename: str = Form(...),
    chapterIndex: int = Form(...)
):
    """Retrieve raw text content of a specific chapter."""
    auth_error = _authorization_error(request, userId)
    if auth_error:
        return auth_error

    try:
        bucket = storage.bucket()
        blob_path = f"users/{userId}/files/{filename}"
        blob = bucket.blob(blob_path)
        
        with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as tmp:
            tmp_path = tmp.name
            
            # 1. Check if we need to recover text from segments
            is_recovered = False
            if not blob.exists() and bookId:
                story_ref = db_admin.collection("users").document(userId).collection("stories").document(bookId)
                story_doc = story_ref.get()
                if story_doc.exists:
                    meta = story_doc.to_dict()
                    if meta.get("isSegmented") and meta.get("segmentsCount"):
                        print(f"[Content] Source .txt missing but segments found for {bookId}. Reconstructing...")
                        recovered_text = reconstruct_text_from_segments(userId, bookId, meta["segmentsCount"])
                        if recovered_text:
                            with open(tmp_path, "w", encoding="utf-8") as f:
                                f.write(recovered_text)
                            is_recovered = True

            if not is_recovered:
                if not blob.exists():
                    return JSONResponse({"error": "File not found"}, status_code=404)
                blob.download_to_filename(tmp_path)
        
        try:
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

@app.post("/api/update-chapter")
async def update_chapter(
    request: Request,
    userId: str = Form(...),
    bookId: str = Form(...),
    filename: str = Form(...),
    chapterIndex: int = Form(...),
    newContent: str = Form(...)
):
    """Update raw text content of a specific chapter and re-upload."""
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
        
        with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as tmp:
            tmp_path = tmp.name
            
            # 1. Check if we need to recover text from segments
            is_recovered = False
            if not blob.exists() and bookId:
                story_ref = db_admin.collection("users").document(userId).collection("stories").document(bookId)
                story_doc = story_ref.get()
                if story_doc.exists:
                    meta = story_doc.to_dict()
                    if meta.get("isSegmented") and meta.get("segmentsCount"):
                        print(f"[Edit] Source .txt missing but segments found for {bookId}. Reconstructing...")
                        recovered_text = reconstruct_text_from_segments(userId, bookId, meta["segmentsCount"])
                        if recovered_text:
                            with open(tmp_path, "w", encoding="utf-8") as f:
                                f.write(recovered_text)
                            is_recovered = True

            if not is_recovered:
                if not blob.exists():
                    return JSONResponse({"error": "File not found"}, status_code=404)
                blob.download_to_filename(tmp_path)
        
        try:
            chapters = parse_chapters_from_file(tmp_path)
            if 0 <= chapterIndex < len(chapters):
                # Update the chapter content
                chapters[chapterIndex]['content'] = newContent
                
                # Reconstruct file
                with open(tmp_path, "w", encoding="utf-8") as f:
                    for i, chap in enumerate(chapters):
                        if i > 0:
                            f.write("\n\n===\n\n")
                        f.write(chap['content'])
                
                # Re-upload master .txt
                blob.upload_from_filename(tmp_path)
                
                # ── SYNC SEGMENTS IF NEEDED ──
                total_chapters = len(chapters)
                is_segmented = total_chapters > 200
                
                if is_segmented:
                    segments = partition_chapters(chapters)
                    chapter_counts = []  # Collect per-chapter counts
                    
                    # Sequential segment upload to prevent OOM
                    for i, seg_chapters in enumerate(segments):
                        print(f"[Update] Syncing segment {i}/{len(segments)-1}...")
                        seg_data = []
                        for chap in seg_chapters:
                            sentences = split_text_into_chunks(chap['content'])
                            chapter_counts.append(len(sentences))  # Store count before cleanup
                            seg_data.append({"title": chap['title'], "sentences": sentences})
                        
                        seg_blob_path = f"users/{userId}/stories/{bookId}/segments/seg_{i}.json"
                        bucket.blob(seg_blob_path).upload_from_string(json.dumps(seg_data), content_type="application/json")
                        
                        # Memory cleanup
                        del seg_data
                        gc.collect()
                    
                    # Update Firestore
                    db_admin.collection("users").document(userId).collection("stories").document(bookId).set({
                        "totalChapters": total_chapters,
                        "segmentsCount": len(segments),
                        "chapterCounts": chapter_counts,
                        "isSegmented": True,
                        "updatedAt": firestore.SERVER_TIMESTAMP
                    }, merge=True)
                else:
                    # Update chaptersSummary in Firestore
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
                
                # Return updated metadata for this chapter
                # Re-parse the updated content to get new title and sentences
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

class ChapterDownloadItem(BaseModel):
    chapterIndex: int
    title: str
    sentences: List[str]

class ChapterDownloadRequest(BaseModel):
    bookTitle: str
    chapters: List[ChapterDownloadItem]
    voice: str = "vi-VN-HoaiMyNeural"
    rate: str = "+0%"
    pitch: str = "+0Hz"
    volume: str = "+0%"

@app.post("/api/download-chapters")
async def download_chapters(request: Request, req: ChapterDownloadRequest):
    """Generate a single MP3 file from selected chapters and stream as download."""
    if _verify_bearer_token(request.headers.get("authorization", "")) is None:
        return JSONResponse({"error": "Authentication required"}, status_code=401)
    if not req.chapters or len(req.chapters) > MAX_DOWNLOAD_CHAPTERS:
        return JSONResponse({"error": f"Select between 1 and {MAX_DOWNLOAD_CHAPTERS} chapters"}, status_code=413)
    sentence_count = sum(len(chapter.sentences) for chapter in req.chapters)
    if sentence_count > MAX_DOWNLOAD_SENTENCES:
        return JSONResponse({"error": f"Download exceeds the {MAX_DOWNLOAD_SENTENCES}-sentence limit"}, status_code=413)
    for chapter in req.chapters:
        for sentence in chapter.sentences:
            text_error = _validate_text_size(sentence, "sentence")
            if text_error:
                return text_error
    indices = [c.chapterIndex for c in req.chapters]
    xx = min(indices) + 1  # 1-indexed for display
    yy = max(indices) + 1
    
    # Sanitize book title for filename
    safe_title = re.sub(r'[^\w\s-]', '', req.bookTitle).strip().replace(' ', '_')
    filename = f"{safe_title}_{xx:02d}_{yy:02d}.mp3"
    
    async def generate_audio():
        for chapter in req.chapters:
            # Join all sentences into full chapter text for a single TTS call
            full_text = "\n".join(chapter.sentences)
            print(f"[Download] Generating chapter: {chapter.title} ({len(full_text)} chars)")
            try:
                communicate = edge_tts.Communicate(
                    full_text, req.voice,
                    rate=req.rate, pitch=req.pitch, volume=req.volume
                )
                async for chunk in _iter_tts_chunks(communicate):
                    if chunk["type"] == "audio":
                        yield chunk["data"]
            except Exception as e:
                print(f"[Download] TTS Error for chapter {chapter.title}: {e}")
                continue
    
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"'
    }
    
    return StreamingResponse(generate_audio(), media_type="audio/mpeg", headers=headers)

# Main route for index.html
@app.get("/")
async def get_index():
    return FileResponse(os.path.join(static_dir, "index.html"))

@app.get("/api/ping")
async def api_ping():
    return {"status": "ok", "message": "Keep-alive ping received"}

# Serving static files
app.mount("/static", StaticFiles(directory=static_dir), name="static")

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    queue = asyncio.Queue(maxsize=MAX_WS_QUEUE)
    state = {"active_session": -1, "current_workers": 0, "authenticated": False, "uid": None}
    worker_pool = {} # worker_id -> Task
    ws_lock = asyncio.Lock()

    async def receiver():
        try:
            while True:
                msg = await websocket.receive_json()
                if not state["authenticated"]:
                    if msg.get("type") != "AUTH":
                        await websocket.close(code=1008, reason="Authentication required")
                        return
                    claims = _verify_bearer_token(f"Bearer {msg.get('token', '')}")
                    if claims is None:
                        await websocket.close(code=1008, reason="Invalid or expired authentication token")
                        return
                    uid = claims.get("uid")
                    async with _active_ws_lock:
                        if _active_ws_by_uid.get(uid, 0) >= MAX_WS_PER_USER:
                            await websocket.close(code=1013, reason="Too many active connections")
                            return
                        _active_ws_by_uid[uid] = _active_ws_by_uid.get(uid, 0) + 1
                    state["uid"] = uid
                    state["authenticated"] = True
                    async with ws_lock:
                        await websocket.send_json({"type": "AUTH_OK"})
                    continue
                if msg["type"] == "PREFETCH":
                    text_error = _validate_text_size(msg.get("text", ""))
                    if text_error:
                        async with ws_lock:
                            await websocket.send_json({
                                "type": "PREFETCH_FAILED",
                                "index": msg.get("index", -1),
                                "chapterIndex": msg.get("chapterIndex", 0),
                                "sessionId": msg.get("sessionId", -1),
                                "error": text_error.body.decode("utf-8") if hasattr(text_error, "body") else "Invalid text"
                            })
                        continue
                    sid = msg.get("sessionId", -1)
                    if sid > state["active_session"]:
                        state["active_session"] = sid
                        print(f"New Active Session: {sid}")
                        # Immediately purge the queue of stale pending tasks
                        while not queue.empty():
                            queue.get_nowait()
                        
                        try:
                            requested_workers = int(msg.get("numWorkers", NUM_WORKERS))
                        except (TypeError, ValueError):
                            requested_workers = NUM_WORKERS
                        requested_workers = max(1, min(requested_workers, MAX_WS_WORKERS))
                        print(f"Aggressive Reset: Killing old workers, spawning {requested_workers} new workers.")
                        
                        # Aggressively kill ALL current workers to abort any stuck network requests
                        for task in worker_pool.values():
                            task.cancel()
                        worker_pool.clear()
                        
                        # Respawn the exact number of requested workers fresh
                        state["current_workers"] = requested_workers
                        for i in range(requested_workers):
                            worker_pool[i] = asyncio.create_task(worker(i))
                        
                    if queue.full():
                        async with ws_lock:
                            await websocket.send_json({
                                "type": "PREFETCH_FAILED",
                                "index": msg.get("index", -1),
                                "chapterIndex": msg.get("chapterIndex", 0),
                                "sessionId": msg.get("sessionId", -1),
                                "error": "TTS queue is full; try again shortly"
                            })
                    else:
                        await queue.put(msg)
                elif msg["type"] == "PING":
                    async with ws_lock:
                        await websocket.send_json({"type": "PONG"})
        except WebSocketDisconnect:
            pass
        except Exception as e:
            print(f"WS Receiver Error: {e}")

    async def worker(worker_id: int):
        try:
            while True:
                msg = await queue.get()
                sid = msg.get("sessionId", -1)
                
                # Immediate check: if task is from a stale session, skip
                if sid < state["active_session"]:
                    print(f"[Worker {worker_id}] Skipping stale task: session {sid} < active {state['active_session']}")
                    queue.task_done()
                    continue
                
                text = msg["text"]
                voice = msg["voice"]
                rate = msg.get("rate", "+0%")
                pitch = msg.get("pitch", "+0Hz")
                volume = msg.get("volume", "+0%")
                
                print(f"[Worker {worker_id}] Generating audio for index {msg['index']} (Session {sid})")
                
                try:
                    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, volume=volume)
                    metadata = []
                    audio_data = b""

                    async for chunk in _iter_tts_chunks(communicate):
                        # CANCEL MID-STREAM instantly if a new session starts
                        if state["active_session"] > sid:
                            print(f"[Worker {worker_id}] Aborting mid-stream: new session detected ({state['active_session']} > {sid})")
                            break
                        
                        if chunk["type"] == "audio":
                            audio_data += chunk["data"]
                        elif chunk["type"] == "WordBoundary":
                            metadata.append({
                                "start": chunk["offset"] / 10_000_000,
                                "duration": chunk["duration"] / 10_000_000,
                                "text": chunk["text"]
                            })
                    
                    # Final check before sending (might have been aborted mid-stream)
                    if state["active_session"] <= sid:
                        try:
                            async with ws_lock:
                                await websocket.send_json({
                                    "type": "METADATA",
                                    "index": msg["index"],
                                    "chapterIndex": msg.get("chapterIndex", 0),
                                    "sessionId": sid,
                                    "metadata": metadata
                                })
                                await websocket.send_bytes(audio_data)
                                await websocket.send_json({
                                    "type": "PREFETCH_DONE",
                                    "index": msg["index"],
                                    "chapterIndex": msg.get("chapterIndex", 0),
                                    "sessionId": sid
                                })
                        except (WebSocketDisconnect, RuntimeError):
                            print(f"[Worker {worker_id}] Send failed: Socket closed.")
                            break
                except Exception as e:
                    print(f"[Worker {worker_id}] Generation Error: {e}")
                    if state["active_session"] <= sid:
                        try:
                            async with ws_lock:
                                await websocket.send_json({
                                    "type": "PREFETCH_FAILED",
                                    "index": msg["index"],
                                    "chapterIndex": msg.get("chapterIndex", 0),
                                    "sessionId": sid,
                                    "error": str(e)
                                })
                        except Exception:
                            pass
                finally:
                    queue.task_done()
        except asyncio.CancelledError:
            print(f"[Worker {worker_id}] Worker task cancelled.")
        except Exception as e:
            print(f"[Worker {worker_id}] Worker Fatal Error: {e}")

    receiver_task = asyncio.create_task(receiver())
    # Initial workers will be spawned by the first PREFETCH message in receiver()
    
    # Wait for either the receiver (disconnect/ping) or any task to finish
    # We now check worker_pool values for the wait
    done, pending = await asyncio.wait(
        [receiver_task],
        return_when=asyncio.FIRST_COMPLETED,
    )

    # Cleanup: cancel receiver and all workers in pool
    receiver_task.cancel()
    for w_task in worker_pool.values():
        w_task.cancel()

    if state["uid"]:
        async with _active_ws_lock:
            remaining = _active_ws_by_uid.get(state["uid"], 0) - 1
            if remaining > 0:
                _active_ws_by_uid[state["uid"]] = remaining
            else:
                _active_ws_by_uid.pop(state["uid"], None)

    # Cancel whatever is left (usually the worker)
    for task in pending:
        task.cancel()

# Supress specific 404s for common devtools/noise paths
@app.get("/.well-known/appspecific/com.chrome.devtools.json")
async def suppress_devtools_404():
    return {}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8008)
