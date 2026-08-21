"""FastAPI application factory and instance."""
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from app.core.config import STATIC_DIR
from app.routers import system, tts, books, ws_tts


def create_app() -> FastAPI:
    application = FastAPI()
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
