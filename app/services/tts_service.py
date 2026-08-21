import asyncio
import logging
from typing import List, AsyncGenerator
from pydantic import BaseModel
import edge_tts
from app.core.config import TTS_CHUNK_TIMEOUT_SECONDS

logger = logging.getLogger("cloud_tts_reader")


class ChapterDownloadItem(BaseModel):
    chapterIndex: int
    title: str
    sentences: List[str]


class ChapterDownloadRequest(BaseModel):
    bookTitle: str
    chapters: List[ChapterDownloadItem]
    voice: str = "vi-VN-HoaiMyNeural"
    rate: str = "+0%"
    pitch: str = "+0Hz"
    volume: str = "+0%"


async def _iter_tts_chunks(communicate) -> AsyncGenerator[dict, None]:
    """Yield TTS chunks while bounding every upstream read."""
    stream = communicate.stream().__aiter__()
    while True:
        try:
            chunk = await asyncio.wait_for(
                stream.__anext__(), timeout=TTS_CHUNK_TIMEOUT_SECONDS
            )
        except StopAsyncIteration:
            return
        yield chunk
