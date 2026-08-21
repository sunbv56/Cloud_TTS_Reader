import re
import logging
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse, JSONResponse
import edge_tts

from app.core.config import MAX_DOWNLOAD_CHAPTERS, MAX_DOWNLOAD_SENTENCES
from app.core.security import _verify_bearer_token, _validate_text_size
from app.services.tts_service import _iter_tts_chunks, ChapterDownloadRequest

logger = logging.getLogger("cloud_tts_reader")

router = APIRouter(tags=["TTS"])


@router.get("/stream/audio")
async def stream_audio(request: Request, text: str, voice: str, rate: str = "+0%", pitch: str = "+0Hz", volume: str = "+0%"):
    if _verify_bearer_token(request.headers.get("authorization", "")) is None:
        return JSONResponse({"error": "Authentication required"}, status_code=401)
    text_error = _validate_text_size(text)
    if text_error:
        return text_error

    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, volume=volume)
    
    async def audio_generator():
        async for chunk in _iter_tts_chunks(communicate):
            if chunk["type"] == "audio":
                yield chunk["data"]
    
    return StreamingResponse(audio_generator(), media_type="audio/mpeg")


@router.get("/stream/metadata")
async def stream_metadata(request: Request, text: str, voice: str, rate: str = "+0%", pitch: str = "+0Hz", volume: str = "+0%"):
    if _verify_bearer_token(request.headers.get("authorization", "")) is None:
        return JSONResponse({"error": "Authentication required"}, status_code=401)
    text_error = _validate_text_size(text)
    if text_error:
        return text_error

    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, volume=volume)
    metadata = []
    async for chunk in _iter_tts_chunks(communicate):
        if chunk["type"] == "WordBoundary":
            metadata.append({
                "start": chunk["offset"] / 10_000_000,
                "duration": chunk["duration"] / 10_000_000,
                "text": chunk["text"]
            })
    return JSONResponse(metadata)


@router.post("/api/download-chapters")
async def download_chapters(request: Request, req: ChapterDownloadRequest):
    """Generate a single MP3 file from selected chapters and stream as download."""
    if _verify_bearer_token(request.headers.get("authorization", "")) is None:
        return JSONResponse({"error": "Authentication required"}, status_code=401)
    if not req.chapters or len(req.chapters) > MAX_DOWNLOAD_CHAPTERS:
        return JSONResponse({"error": f"Select between 1 and {MAX_DOWNLOAD_CHAPTERS} chapters"}, status_code=413)
    sentence_count = sum(len(chapter.sentences) for chapter in req.chapters)
    if sentence_count > MAX_DOWNLOAD_SENTENCES:
        return JSONResponse({"error": f"Download exceeds the {MAX_DOWNLOAD_SENTENCES}-sentence limit"}, status_code=413)
    for chapter in req.chapters:
        for sentence in chapter.sentences:
            text_error = _validate_text_size(sentence, "sentence")
            if text_error:
                return text_error
    indices = [c.chapterIndex for c in req.chapters]
    xx = min(indices) + 1  # 1-indexed for display
    yy = max(indices) + 1
    
    # Sanitize book title for filename
    safe_title = re.sub(r'[^\w\s-]', '', req.bookTitle).strip().replace(' ', '_')
    filename = f"{safe_title}_{xx:02d}_{yy:02d}.mp3"
    
    async def generate_audio():
        for chapter in req.chapters:
            full_text = "\n".join(chapter.sentences)
            logger.info("[Download] Generating chapter: %s (%d chars)", chapter.title, len(full_text))
            try:
                communicate = edge_tts.Communicate(
                    full_text, req.voice,
                    rate=req.rate, pitch=req.pitch, volume=req.volume
                )
                async for chunk in _iter_tts_chunks(communicate):
                    if chunk["type"] == "audio":
                        yield chunk["data"]
            except Exception as e:
                logger.error("[Download] TTS Error for chapter %s: %s", chapter.title, e)
                continue
    
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"'
    }
    
    return StreamingResponse(generate_audio(), media_type="audio/mpeg", headers=headers)
