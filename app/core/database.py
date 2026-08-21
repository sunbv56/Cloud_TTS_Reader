import os
import json
import logging
import firebase_admin
from firebase_admin import credentials, storage as firebase_storage, firestore, auth
from storage_adapter import get_storage_backend

logger = logging.getLogger("cloud_tts_reader")

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
        logger.info("Firebase Admin initialized via environment variable.")
        firebase_admin_initialized = True
    except Exception as e:
        logger.error(f"Error initializing Firebase Admin with service account: {e}")
        if firebase_creds_json:
            logger.debug(f"Creds JSON starts with: {firebase_creds_json[:20]}...")
else:
    # Try default initialization (e.g. if running on GCP/GCE)
    try:
        firebase_admin.initialize_app(options={
            'storageBucket': os.getenv("FIREBASE_STORAGE_BUCKET")
        })
        logger.info("Firebase Admin initialized via default credentials.")
        firebase_admin_initialized = True
    except Exception as e:
        logger.warning(f"Warning: Firebase Admin could not be initialized (local dev?). Storage features will be limited: {e}")

try:
    if firebase_admin_initialized:
        db_admin = firestore.client()
    else:
        db_admin = None
except Exception as e:
    logger.error(f"Firestore client could not be initialized: {e}")
    db_admin = None

# Keep the existing bucket/blob interface while allowing the storage provider
# to be switched through STORAGE_BACKEND=b2 without changing Firestore paths.
try:
    storage = get_storage_backend(firebase_storage)
except Exception as e:
    logger.error(f"Storage backend could not be initialized: {e}")
    storage = None


def is_storage_not_found(exc: Exception) -> bool:
    """Normalize Firebase and B2 not-found exceptions for direct downloads."""
    if type(exc).__name__ in {"NotFound", "NoSuchKey", "ResourceNotFoundError"}:
        return True
    if hasattr(exc, "response") and isinstance(exc.response, dict):
        status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        code = exc.response.get("Error", {}).get("Code")
        if status == 404 or code in {"404", "NoSuchKey", "NotFound"}:
            return True
    if storage is not None:
        checker = getattr(storage, "is_not_found", None)
        if checker and checker(exc):
            return True
    return False
