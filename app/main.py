"""FastAPI application factory and instance."""
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



def create_app() -> FastAPI:
    application = FastAPI(lifespan=lifespan)
    application.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    application.include_router(system.router)
    application.include_router(tts.router)
    application.include_router(books.router)
    application.include_router(ws_tts.router)
    return application


app = create_app()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8008)

