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


class _LazyFirestoreProxy:
    """Lazy proxy that defers Firestore gRPC client connection until first access."""
    def __init__(self):
        self._client = None

    def _get_client(self):
        if self._client is None and firebase_admin_initialized:
            try:
                self._client = firestore.client()
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


db_admin = _LazyFirestoreProxy() if firebase_admin_initialized else None
storage = _LazyStorageProxy() if (firebase_admin_initialized or os.getenv("STORAGE_BACKEND", "").lower() == "b2") else None


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

