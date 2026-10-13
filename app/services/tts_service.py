import asyncio
import io
import logging
import re
from typing import List, AsyncGenerator
from pydantic import BaseModel
import edge_tts
from app.core.config import (
    TTS_CHUNK_TIMEOUT_SECONDS,
    EDGE_TTS_PROXY,
    EDGE_TTS_HEDGE_SECONDS,
    EDGE_TTS_PIECE_CHARS,
    EDGE_TTS_FIRST_PIECE_CHARS,
    GTTS_FALLBACK,
)

logger = logging.getLogger("cloud_tts_reader")

EDGE_TTS_ATTEMPTS = 4
EDGE_TTS_PIECE_CONCURRENCY = 3
EDGE_TTS_PIECE_ROUNDS = 3
EDGE_TTS_MAX_CONNECTIONS = 4  # bounds connection/RAM spikes on the 256MB VM
EDGE_TTS_BITRATE = 48_000  # edge_tts output: audio-24khz-48kbitrate-mono-mp3


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
    try:
        while True:
            try:
                chunk = await asyncio.wait_for(
                    stream.__anext__(), timeout=TTS_CHUNK_TIMEOUT_SECONDS
                )
            except StopAsyncIteration:
                return
            yield chunk
    finally:
        await stream.aclose()


def _gtts_lang(voice: str) -> str:
    """Map an Edge voice name (vi-VN-HoaiMyNeural) to a gTTS language code (vi)."""
    return (voice or "vi").split("-", 1)[0].lower() or "vi"


def _gtts_bytes(text: str, lang: str) -> bytes:
    from gtts import gTTS  # emergency-only path; keep it out of startup RAM
    buf = io.BytesIO()
    gTTS(text, lang=lang).write_to_fp(buf)
    return buf.getvalue()


_edge_slots: tuple[asyncio.AbstractEventLoop, asyncio.Semaphore] | None = None


def _get_edge_slots() -> asyncio.Semaphore:
    # Bound to the running loop: a semaphore must not be shared across loops.
    global _edge_slots
    loop = asyncio.get_running_loop()
    if _edge_slots is None or _edge_slots[0] is not loop:
        _edge_slots = (loop, asyncio.Semaphore(EDGE_TTS_MAX_CONNECTIONS))
    return _edge_slots[1]


class _SlotStream:
    """Chunk iterator that gives its Edge connection slot back exactly once,
    when closed or exhausted (an unstarted async generator's finally would
    never run on aclose, leaking the slot)."""

    def __init__(self, stream, slots: asyncio.Semaphore):
        self._stream = stream
        self._slots = slots
        self._released = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return await self._stream.__anext__()
        except BaseException:
            await self.aclose()
            raise

    async def aclose(self):
        if not self._released:
            self._released = True
            try:
                await self._stream.aclose()
            finally:
                self._slots.release()


async def _open_stream(text, voice, rate, pitch, volume, proxy):
    """Start an Edge TTS stream and return (chunks so far, iterator) once the
    first audio chunk arrives, so a racing attempt can be picked as winner.
    Edge answers "No audio" en masse when one IP opens many connections at
    once, so every attempt (hedges included) holds a slot from a global pool."""
    slots = _get_edge_slots()
    await slots.acquire()
    try:
        communicate = edge_tts.Communicate(
            text, voice, rate=rate, pitch=pitch, volume=volume,
            boundary="WordBoundary", proxy=proxy,
        )
    except BaseException:
        slots.release()
        raise
    stream = _SlotStream(_iter_tts_chunks(communicate), slots)
    head = []
    try:
        async for chunk in stream:
            head.append(chunk)
            if chunk["type"] == "audio":
                return head, stream
    except BaseException:
        await stream.aclose()
        raise
    await stream.aclose()
    raise edge_tts.exceptions.NoAudioReceived("Stream ended without audio")


async def _race_first_audio(text, voice, rate, pitch, volume):
    """Hedged start: Edge sometimes stalls ~10s or answers "No audio" after
    ~3s. Instead of waiting that out, launch another attempt when the current
    one has not produced audio within EDGE_TTS_HEDGE_SECONDS, alternating
    direct and proxy routes, and keep whichever produces audio first."""
    routes = [None, EDGE_TTS_PROXY] if EDGE_TTS_PROXY else [None]
    pending: set[asyncio.Task] = set()
    launched = 0
    last_error: Exception | None = None

    def launch():
        nonlocal launched
        proxy = routes[launched % len(routes)]
        launched += 1
        pending.add(asyncio.create_task(_open_stream(text, voice, rate, pitch, volume, proxy)))

    launch()
    try:
        while pending:
            can_hedge = launched < EDGE_TTS_ATTEMPTS
            done, _ = await asyncio.wait(
                pending,
                timeout=EDGE_TTS_HEDGE_SECONDS if can_hedge else None,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not done:
                launch()
                continue
            winner = None
            for task in done:
                pending.discard(task)
                if task.exception() is not None:
                    last_error = task.exception()
                    logger.warning(
                        "[TTS] Edge TTS attempt failed (%d/%d launched): %s",
                        launched, EDGE_TTS_ATTEMPTS, last_error,
                    )
                elif winner is None:
                    winner = task.result()
                else:
                    await task.result()[1].aclose()
            if winner is not None:
                return winner
            if not pending and launched < EDGE_TTS_ATTEMPTS:
                launch()
    finally:
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
    raise last_error or edge_tts.exceptions.NoAudioReceived("Edge TTS failed")


_SENTENCE_END = re.compile(r"(?<=[.!?…;:])\s+")
_CLAUSE_END = re.compile(r"(?<=[,，])\s+")
_HAS_SPEECH = re.compile(r"\w")


def _pack(parts: List[str], limit: int, first_limit: int) -> List[str]:
    """Greedily join consecutive parts while they stay within the limit; the
    first piece uses a tighter limit so streaming playback starts sooner."""
    pieces: List[str] = []
    for part in parts:
        cap = first_limit if len(pieces) == 1 else limit
        if pieces and len(pieces[-1]) + 1 + len(part) <= cap:
            pieces[-1] = f"{pieces[-1]} {part}"
        else:
            pieces.append(part)
    return pieces


def split_for_tts(
    text: str, limit: int = EDGE_TTS_PIECE_CHARS, first_limit: int = EDGE_TTS_FIRST_PIECE_CHARS
) -> List[str]:
    """Split a long paragraph at sentence (then clause) boundaries.
    Edge's time-to-first-audio grows with input length (measured ~4s for 25
    chars vs 16-26s for 370 chars on fresh text), so short pieces synthesized
    in parallel start much sooner and fail cheaper."""
    text = text.strip()
    if len(text) <= limit:
        return [text]
    first_limit = min(first_limit, limit)
    parts: List[str] = []
    for sentence in _SENTENCE_END.split(text):
        cap = first_limit if not parts else limit
        if len(sentence) > cap:
            parts.extend(_CLAUSE_END.split(sentence))
        else:
            parts.append(sentence)
    pieces = _pack([p for p in parts if p], limit, first_limit)
    # A piece without letters or digits makes Edge answer "No audio received".
    merged: List[str] = []
    for piece in pieces:
        if merged and not _HAS_SPEECH.search(piece):
            merged[-1] = f"{merged[-1]} {piece}"
        else:
            merged.append(piece)
    return merged


def _audio_ticks(byte_count: int) -> int:
    """Duration in 100ns ticks of Edge's CBR 48 kbit/s MP3 output."""
    return byte_count * 8 * 10_000_000 // EDGE_TTS_BITRATE


async def _collect_piece(text, voice, rate, pitch, volume) -> List[dict]:
    """One failed piece would fail the whole paragraph, so give each piece a
    few extra rounds; a burst of Edge "No audio" answers usually passes."""
    for round_no in range(EDGE_TTS_PIECE_ROUNDS):
        try:
            return [chunk async for chunk in _synthesize_piece(text, voice, rate, pitch, volume)]
        except Exception:
            if round_no == EDGE_TTS_PIECE_ROUNDS - 1:
                raise
            await asyncio.sleep(0.5 * (round_no + 1))


async def synthesize_pieces(
    text: str, voice: str, rate: str = "+0%", pitch: str = "+0Hz", volume: str = "+0%"
) -> AsyncGenerator[List[dict], None]:
    """Yield each piece's chunks in reading order as soon as that piece (and
    all before it) is ready, while later pieces keep synthesizing in parallel.
    Word-boundary offsets stay relative to the piece's own audio."""
    pieces = split_for_tts(text)
    limiter = asyncio.Semaphore(EDGE_TTS_PIECE_CONCURRENCY)

    async def run(piece):
        async with limiter:
            return await _collect_piece(piece, voice, rate, pitch, volume)

    tasks = [asyncio.create_task(run(piece)) for piece in pieces]
    try:
        for task in tasks:
            yield await task
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def synthesize_chunks(
    text: str, voice: str, rate: str = "+0%", pitch: str = "+0Hz", volume: str = "+0%"
) -> AsyncGenerator[dict, None]:
    """Yield Edge TTS chunks for text on one continuous timeline, re-basing
    each piece's word-boundary offsets by the audio that precedes it."""
    if len(split_for_tts(text)) == 1:
        async for chunk in _synthesize_piece(text.strip(), voice, rate, pitch, volume):
            yield chunk
        return
    offset = 0
    async for piece_chunks in synthesize_pieces(text, voice, rate, pitch, volume):
        piece_bytes = 0
        for chunk in piece_chunks:
            if chunk["type"] == "audio":
                piece_bytes += len(chunk["data"])
                yield chunk
            elif chunk["type"] == "WordBoundary":
                yield {**chunk, "offset": chunk["offset"] + offset}
        offset += _audio_ticks(piece_bytes)


async def _synthesize_piece(
    text: str, voice: str, rate: str = "+0%", pitch: str = "+0Hz", volume: str = "+0%"
) -> AsyncGenerator[dict, None]:
    """Yield Edge TTS chunks, retrying failures that happen before any audio.
    gTTS is only used when GTTS_FALLBACK is enabled: mixing its voice into an
    Edge reading sounds jarring, so by default the error reaches the client,
    which retries the sentence itself."""
    try:
        head, stream = await _race_first_audio(text, voice, rate, pitch, volume)
    except Exception:
        if not GTTS_FALLBACK:
            raise
    else:
        try:
            for chunk in head:
                yield chunk
            async for chunk in stream:
                yield chunk
        finally:
            await stream.aclose()
        return
    logger.warning("[TTS] Edge TTS unavailable, falling back to gTTS")
    data = await asyncio.to_thread(_gtts_bytes, text, _gtts_lang(voice))
    yield {"type": "audio", "data": data}
