import asyncio
import io
import logging
from typing import List, AsyncGenerator
from pydantic import BaseModel
import edge_tts
from gtts import gTTS
from app.core.config import TTS_CHUNK_TIMEOUT_SECONDS, EDGE_TTS_PROXY, GTTS_FALLBACK

logger = logging.getLogger("cloud_tts_reader")

EDGE_TTS_ATTEMPTS = 3
EDGE_TTS_RETRY_DELAY_SECONDS = 0.5


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


def _gtts_lang(voice: str) -> str:
    """Map an Edge voice name (vi-VN-HoaiMyNeural) to a gTTS language code (vi)."""
    return (voice or "vi").split("-", 1)[0].lower() or "vi"


def _gtts_bytes(text: str, lang: str) -> bytes:
    buf = io.BytesIO()
    gTTS(text, lang=lang).write_to_fp(buf)
    return buf.getvalue()


async def synthesize_chunks(
    text: str, voice: str, rate: str = "+0%", pitch: str = "+0Hz", volume: str = "+0%"
) -> AsyncGenerator[dict, None]:
    """Yield Edge TTS chunks, retrying failures that happen before any audio.
    gTTS is only used when GTTS_FALLBACK is enabled: mixing its voice into an
    Edge reading sounds jarring, so by default the error reaches the client,
    which retries the sentence itself."""
    got_audio = False
    last_error: Exception | None = None
    for attempt in range(EDGE_TTS_ATTEMPTS):
        if attempt:
            await asyncio.sleep(EDGE_TTS_RETRY_DELAY_SECONDS * attempt)
        try:
            communicate = edge_tts.Communicate(
                text, voice, rate=rate, pitch=pitch, volume=volume,
                boundary="WordBoundary", proxy=EDGE_TTS_PROXY,
            )
            async for chunk in _iter_tts_chunks(communicate):
                if chunk["type"] == "audio":
                    got_audio = True
                yield chunk
            return
        except Exception as e:
            if got_audio:
                raise
            last_error = e
            logger.warning(
                "[TTS] Edge TTS attempt %d/%d failed (%s)", attempt + 1, EDGE_TTS_ATTEMPTS, e
            )
    if not GTTS_FALLBACK:
        raise last_error
    logger.warning("[TTS] Edge TTS unavailable, falling back to gTTS")
    data = await asyncio.to_thread(_gtts_bytes, text, _gtts_lang(voice))
    yield {"type": "audio", "data": data}
