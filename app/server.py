"""FastAPI application factory and instance."""
import sys
from pathlib import Path

# Allow direct script execution if needed
_PKG_ROOT = Path(__file__).resolve().parent.parent
if str(_PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(_PKG_ROOT))

from contextlib import asynccontextmanager
from urllib.parse import parse_qs
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
    """Unversioned app-shell files revalidate via ETag (no-cache) so a deploy is
    picked up at once; ?v=<hash> URLs change with their content, so they are
    cached for good."""
    _REVALIDATE_SUFFIXES = (".js", ".css", ".html", ".json")
    _MEDIA_SUFFIXES = (".png", ".svg", ".webp", ".jpg", ".jpeg", ".ico", ".woff2")

    def file_response(self, full_path, stat_result, scope, *args, **kwargs):
        response = super().file_response(full_path, stat_result, scope, *args, **kwargs)
        path = str(full_path)
        if "v" in parse_qs(scope.get("query_string", b"").decode()):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        elif path.endswith(self._REVALIDATE_SUFFIXES):
            response.headers["Cache-Control"] = "no-cache"
        elif path.endswith(self._MEDIA_SUFFIXES):
            response.headers["Cache-Control"] = "public, max-age=604800"
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
