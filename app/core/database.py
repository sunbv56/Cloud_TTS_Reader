import os
import logging
from app.core import google_lite
from storage_adapter import get_storage_backend

logger = logging.getLogger("cloud_tts_reader")

# Firebase Auth and Firestore go through app.core.google_lite (REST) instead
# of firebase-admin, whose gRPC Firestore stack cost ~32 MB of RSS. The name
# `firebase_admin_initialized` is kept: it means "service account loaded".
firebase_admin_initialized = False
_service_account = None

try:
    _service_account = google_lite.load_service_account(os.getenv("FIREBASE_SERVICE_ACCOUNT"))
    if _service_account is not None:
        google_lite.configure_auth(_service_account.project_id)
        firebase_admin_initialized = True
        logger.info("Firebase credentials loaded from FIREBASE_SERVICE_ACCOUNT.")
    else:
        logger.warning("FIREBASE_SERVICE_ACCOUNT is not set; Firebase features are disabled (local dev?).")
except Exception as e:
    logger.error(f"Error loading Firebase service account: {e}")


def _init_firebase_admin_for_storage():
    """Only the legacy Firebase Storage backend still needs firebase-admin; it
    is imported lazily so B2 deployments never pay for it."""
    import firebase_admin
    from firebase_admin import credentials, storage as firebase_storage
    if not firebase_admin._apps:
        firebase_admin.initialize_app(
            credentials.Certificate(_service_account.info) if _service_account else None,
            {"storageBucket": os.getenv("FIREBASE_STORAGE_BUCKET")},
        )
    return firebase_storage


class _LazyFirestoreProxy:
    """Lazy proxy that creates the REST Firestore client on first access."""
    def __init__(self):
        self._client = None

    def _get_client(self):
        if self._client is None and _service_account is not None:
            try:
                self._client = google_lite.FirestoreClient(_service_account)
            except Exception as e:
                logger.error(f"Firestore client could not be initialized: {e}")
                self._client = None
        return self._client


    def collection(self, *args, **kwargs):
        client = self._get_client()
        if client is None:
            raise RuntimeError("Firestore is not initialized or unavailable")
        return client.collection(*args, **kwargs)

    def document(self, *args, **kwargs):
        client = self._get_client()
        if client is None:
            raise RuntimeError("Firestore is not initialized or unavailable")
        return client.document(*args, **kwargs)

    def batch(self, *args, **kwargs):
        client = self._get_client()
        if client is None:
            raise RuntimeError("Firestore is not initialized or unavailable")
        return client.batch(*args, **kwargs)

    def transaction(self, *args, **kwargs):
        client = self._get_client()
        if client is None:
            raise RuntimeError("Firestore is not initialized or unavailable")
        return client.transaction(*args, **kwargs)

    def __getattr__(self, name):
        client = self._get_client()
        if client is None:
            raise RuntimeError("Firestore is not initialized or unavailable")
        return getattr(client, name)

    def __bool__(self):
        return bool(firebase_admin_initialized)

    def __repr__(self):
        return f"<LazyFirestoreProxy initialized={bool(self._client)}>"


class _LazyStorageProxy:
    """Lazy proxy that defers storage backend instantiation until first file/blob access."""
    def __init__(self):
        self._backend = None

    def _get_backend(self):
        if self._backend is None:
            try:
                firebase_storage = None
                if os.getenv("STORAGE_BACKEND", "firebase").strip().lower() != "b2":
                    try:
                        firebase_storage = _init_firebase_admin_for_storage()
                    except Exception as e:
                        logger.error(f"Firebase Storage could not be initialized: {e}")
                self._backend = get_storage_backend(firebase_storage)
                backend_type = getattr(self._backend, "provider_name", "unknown")
                bucket_name = getattr(self._backend, "bucket_name", None) or os.getenv("FIREBASE_STORAGE_BUCKET") or "(default)"
                logger.info(f"Storage backend initialized: provider={backend_type} bucket={bucket_name}")
            except Exception as e:
                logger.error(f"Storage backend could not be initialized: {e}")
                self._backend = None
        return self._backend

    @property
    def provider_name(self):
        backend = self._get_backend()
        return getattr(backend, "provider_name", "unknown") if backend else "none"

    @property
    def bucket_name(self):
        backend = self._get_backend()
        return getattr(backend, "bucket_name", None) if backend else None

    def get_diagnostic_info(self) -> dict:
        backend = self._get_backend()
        if backend is not None and hasattr(backend, "get_diagnostic_info"):
            return backend.get_diagnostic_info()
        return {
            "provider": "none",
            "bucket": "(missing)",
            "configured": False,
            "connected": False,
            "error": "Storage backend is not initialized.",
        }

    def bucket(self, *args, **kwargs):
        backend = self._get_backend()
        if backend is None:
            raise RuntimeError("Storage backend is not initialized")
        return backend.bucket(*args, **kwargs)

    def blob(self, *args, **kwargs):
        backend = self._get_backend()
        if backend is None:
            raise RuntimeError("Storage backend is not initialized")
        return backend.blob(*args, **kwargs)

    def list_keys(self, *args, **kwargs):
        backend = self._get_backend()
        if backend is None:
            raise RuntimeError("Storage backend is not initialized")
        return backend.list_keys(*args, **kwargs)

    def delete_prefix(self, *args, **kwargs):
        backend = self._get_backend()
        if backend is None:
            raise RuntimeError("Storage backend is not initialized")
        return backend.delete_prefix(*args, **kwargs)

    def is_not_found(self, exc):
        backend = self._get_backend()
        if backend is not None and hasattr(backend, "is_not_found"):
            return backend.is_not_found(exc)
        return False

    def __getattr__(self, name):
        backend = self._get_backend()
        if backend is None:
            raise RuntimeError("Storage backend is not initialized")
        return getattr(backend, name)

    def __bool__(self):
        return bool(firebase_admin_initialized or os.getenv("STORAGE_BACKEND", "").lower() == "b2")

    def __repr__(self):
        return f"<LazyStorageProxy initialized={bool(self._backend)}>"


class _FirestoreProxy:
    """Firestore constants used by the app (SERVER_TIMESTAMP)."""
    SERVER_TIMESTAMP = google_lite.SERVER_TIMESTAMP


firestore = _FirestoreProxy()
db_admin = _LazyFirestoreProxy() if firebase_admin_initialized else None
storage = _LazyStorageProxy() if (firebase_admin_initialized or os.getenv("STORAGE_BACKEND", "").lower() == "b2") else None



def _warmup_connections():
    """Warm up Firestore, Auth and Storage connections at boot so users experience 0s delay."""
    try:
        if db_admin is not None and hasattr(db_admin, "_get_client"):
            db_admin._get_client()
        if storage is not None and hasattr(storage, "_get_backend"):
            storage._get_backend()
        logger.info("Database and Storage connections pre-warmed for instant user response.")
    except Exception as e:
        logger.warning(f"Connection warmup encountered error: {e}")


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


