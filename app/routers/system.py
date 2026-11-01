import os
import re
import time
from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from app.core.config import STATIC_DIR
from app.core.database import storage

router = APIRouter(tags=["System"])

_HOST_RE = re.compile(r"^[A-Za-z0-9.-]+(:\d{1,5})?$")
_index_html: str | None = None


def _request_origin(request: Request) -> str:
    """Absolute origin for link-preview tags (og:image must be absolute); empty if the Host looks forged."""
    proto = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip()
    if proto not in ("http", "https"):
        proto = request.url.scheme
    host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(",")[0].strip()
    return f"{proto}://{host}" if _HOST_RE.match(host) else ""


@router.get("/")
async def get_index(request: Request):
    global _index_html
    if _index_html is None:
        with open(os.path.join(STATIC_DIR, "index.html"), encoding="utf-8") as f:
            _index_html = f.read()
    return HTMLResponse(_index_html.replace("__ORIGIN__", _request_origin(request)), headers={"Cache-Control": "no-cache"})


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


@router.get("/api/system/memory-stats")
async def get_memory_stats():
    """Return detailed memory metrics: Python RSS, Cgroup, and Linux MemInfo."""
    import gc
    stats = {
        "timestamp": int(time.time()),
        "python": {},
        "cgroup": {},
        "system": {},
    }
    
    # 1. Python process memory
    try:
        import psutil
        proc = psutil.Process()
        mem = proc.memory_info()
        stats["python"]["rss_mb"] = round(mem.rss / (1024 * 1024), 2)
        stats["python"]["vms_mb"] = round(mem.vms / (1024 * 1024), 2)
    except Exception:
        # Fallback reading /proc/self/status on Linux
        try:
            with open("/proc/self/status", "r") as f:
                for line in f:
                    if line.startswith("VmRSS:"):
                        stats["python"]["rss_mb"] = round(int(line.split()[1]) / 1024, 2)
                    elif line.startswith("VmSize:"):
                        stats["python"]["vms_mb"] = round(int(line.split()[1]) / 1024, 2)
        except Exception as e:
            stats["python"]["error"] = str(e)
            
    # 2. Linux /proc/meminfo
    try:
        with open("/proc/meminfo", "r") as f:
            for line in f:
                parts = line.split(":")
                key = parts[0].strip()
                if key in {"MemTotal", "MemFree", "MemAvailable", "Buffers", "Cached", "Active", "Inactive", "Slab"}:
                    val_kb = int(parts[1].strip().split()[0])
                    stats["system"][f"{key.lower()}_mb"] = round(val_kb / 1024, 2)
    except Exception:
        pass

    # 3. Cgroup memory (Fly.io metrics source)
    for cgroup_path in [
        "/sys/fs/cgroup/memory.current",
        "/sys/fs/cgroup/memory/memory.usage_in_bytes",
    ]:
        if os.path.exists(cgroup_path):
            try:
                with open(cgroup_path, "r") as f:
                    val_bytes = int(f.read().strip())
                    stats["cgroup"]["usage_mb"] = round(val_bytes / (1024 * 1024), 2)
                    stats["cgroup"]["source"] = cgroup_path
                    break
            except Exception:
                pass
                
    return JSONResponse(stats)


@router.get("/api/system/metrics")
async def get_metrics_history(minutes: int = 60):
    """RAM/CPU samples collected in-process by app.core.metrics."""
    from app.core import metrics
    minutes = max(1, min(metrics.HISTORY_HOURS * 60, minutes))
    return {
        "sample_seconds": metrics.SAMPLE_SECONDS,
        "history_hours": metrics.HISTORY_HOURS,
        "latest": metrics.latest(),
        "samples": metrics.history(minutes),
    }


@router.get("/monitor")
async def get_monitor_page():
    return FileResponse(os.path.join(STATIC_DIR, "monitor.html"))


@router.post("/api/system/memory-trim")
async def trigger_memory_trim():
    """Manually force garbage collection and return pages to OS."""
    from app.core.memory import _reclaim_memory
    _reclaim_memory()
    return {"status": "ok", "message": "Memory trim executed"}


@router.get("/.well-known/appspecific/com.chrome.devtools.json")
async def suppress_devtools_404():
    return {}

