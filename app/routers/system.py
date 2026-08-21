import os
import time
from fastapi import APIRouter
from fastapi.responses import FileResponse, JSONResponse
from app.core.config import STATIC_DIR
from app.core.database import storage

router = APIRouter(tags=["System"])


@router.get("/")
async def get_index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@router.get("/api/ping")
async def api_ping():
    return {"status": "ok", "message": "Keep-alive ping received"}


@router.get("/api/system/storage-status")
async def get_storage_status():
    if storage is None:
        return JSONResponse({
            "status": "unconfigured",
            "storage": {
                "provider": "none",
                "configured": False,
                "connected": False,
                "error": "Storage backend is not initialized."
            },
            "timestamp": int(time.time())
        }, status_code=503)
    
    diagnostic = getattr(storage, "get_diagnostic_info", None)
    if callable(diagnostic):
        info = diagnostic()
    else:
        info = {
            "provider": getattr(storage, "provider_name", "unknown"),
            "configured": True,
            "connected": True,
            "error": None
        }
    
    is_ok = info.get("connected", False)
    status_code = 200 if is_ok else 503
    return JSONResponse({
        "status": "ok" if is_ok else "error",
        "storage": info,
        "timestamp": int(time.time())
    }, status_code=status_code)


@router.get("/api/firebase-config")
async def get_firebase_config():
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


@router.get("/.well-known/appspecific/com.chrome.devtools.json")
async def suppress_devtools_404():
    return {}
