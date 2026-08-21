import os
import logging
from dotenv import load_dotenv

load_dotenv()  # Load variables from .env if it exists

logger = logging.getLogger("cloud_tts_reader")

# Directory paths
BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STATIC_DIR = os.path.join(BASE_DIR, "static")

# Ensure static directory exists
if not os.path.exists(STATIC_DIR):
    os.makedirs(STATIC_DIR, exist_ok=True)

# Edge-TTS Worker counts
NUM_WORKERS = 2

# Resource limits intentionally conservative for 256 MB Fly.io VM
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
MAX_APPEND_BYTES = int(os.getenv("MAX_APPEND_BYTES", str(10 * 1024 * 1024)))
MAX_APPEND_CHAPTERS = int(os.getenv("MAX_APPEND_CHAPTERS", "1000"))
MAX_TTS_TEXT_CHARS = int(os.getenv("MAX_TTS_TEXT_CHARS", "5000"))
MAX_DOWNLOAD_CHAPTERS = int(os.getenv("MAX_DOWNLOAD_CHAPTERS", "5"))
MAX_DOWNLOAD_SENTENCES = int(os.getenv("MAX_DOWNLOAD_SENTENCES", "50000"))

try:
    MAX_WS_WORKERS = max(1, min(50, int(os.getenv("MAX_WS_WORKERS", "50"))))
    MAX_WS_QUEUE = max(8, min(200, int(os.getenv("MAX_WS_QUEUE", "100"))))
except (TypeError, ValueError):
    MAX_WS_WORKERS = 50
    MAX_WS_QUEUE = 100

MAX_WS_PER_USER = 1
MAX_NEW_CONTENT_CHARS = int(os.getenv("MAX_NEW_CONTENT_CHARS", "1000000"))
TTS_CHUNK_TIMEOUT_SECONDS = float(os.getenv("TTS_CHUNK_TIMEOUT_SECONDS", "30"))
MAX_IMAGE_BYTES = int(os.getenv("MAX_IMAGE_BYTES", str(150 * 1024)))

# Segmentation settings
SEGMENT_CHAPTER_SIZE = 50
SEGMENT_FORMAT_VERSION = 2
MAX_IMPORT_CONCURRENCY = 1
IMPORT_RETRY_AFTER_SECONDS = int(os.getenv("IMPORT_RETRY_AFTER_SECONDS", "15"))

try:
    STORAGE_IO_CONCURRENCY = max(1, min(8, int(os.getenv("STORAGE_IO_CONCURRENCY", "4"))))
    FIRESTORE_IO_CONCURRENCY = max(1, min(8, int(os.getenv("FIRESTORE_IO_CONCURRENCY", "4"))))
except ValueError:
    STORAGE_IO_CONCURRENCY = 4
    FIRESTORE_IO_CONCURRENCY = 4

# Firebase ID tokens clock skew tolerance (Firebase Admin strictly enforces max 60s)
FIREBASE_CLOCK_SKEW_SECONDS = max(
    0, min(60, int(os.getenv("FIREBASE_CLOCK_SKEW_SECONDS", "60")))
)

ALLOWED_BOOK_EXTENSIONS = {".txt", ".epub", ".pdf"}
ALLOWED_BOOK_CONTENT_TYPES = {
    "text/plain", "application/octet-stream", "",
    "application/epub+zip", "application/zip", "application/x-zip-compressed",
    "application/pdf",
}

# Legacy cache settings
LEGACY_SOURCE_CACHE_MAX_FILES = 2
LEGACY_SOURCE_CACHE_MAX_BYTES = 128 * 1024 * 1024
