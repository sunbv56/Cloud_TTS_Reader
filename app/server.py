"""FastAPI application factory and instance."""
import sys
from pathlib import Path

# Allow direct script execution if needed
_PKG_ROOT = Path(__file__).resolve().parent.parent
if str(_PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(_PKG_ROOT))

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from app.core.config import STATIC_DIR
from app.core.memory import _reclaim_memory
from app.routers import system, tts, books, ws_tts


@asynccontextmanager
async def lifespan(application: FastAPI):
    # Pre-warm database & storage connections during boot for 0s user latency
    try:
        from app.core.database import _warmup_connections
        _warmup_connections()
    except Exception:
        pass
    # Reclaim temporary import & compilation caches
    _reclaim_memory()
    yield
    # Shutdown memory reclaim
    _reclaim_memory()


class _RevalidatedStaticFiles(StaticFiles):
    """App-shell files carry no version in their URL, so without Cache-Control
    browsers heuristically keep serving the previous deploy. no-cache still
    allows caching but revalidates via ETag (a cheap 304 when unchanged)."""
    _REVALIDATE_SUFFIXES = (".js", ".css", ".html", ".json")

    def file_response(self, full_path, *args, **kwargs):
        response = super().file_response(full_path, *args, **kwargs)
        if str(full_path).endswith(self._REVALIDATE_SUFFIXES):
            response.headers["Cache-Control"] = "no-cache"
        return response


def create_app() -> FastAPI:
    application = FastAPI(lifespan=lifespan)
    application.mount("/static", _RevalidatedStaticFiles(directory=STATIC_DIR), name="static")
    application.include_router(system.router)
    application.include_router(tts.router)
    application.include_router(books.router)
    application.include_router(ws_tts.router)
    return application


app = create_app()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8008)
