"""API, WebSocket and system routers."""
from app.routers import system, tts, books, ws_tts

__all__ = ["system", "tts", "books", "ws_tts"]
