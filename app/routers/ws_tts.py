import asyncio
import itertools
import logging
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.config import (
    NUM_WORKERS,
    MAX_WS_WORKERS,
    MAX_WS_QUEUE,
    MAX_WS_PER_USER,
)
from app.core.security import _verify_bearer_token, _validate_text_size
from app.services.tts_service import synthesize_chunks, synthesize_pieces, set_tts_options

logger = logging.getLogger("cloud_tts_reader")

router = APIRouter(tags=["WebSocket TTS"])

# uid -> sockets currently holding one of that account's TTS slots.
_active_ws_by_uid = {}
_active_ws_lock = asyncio.Lock()

# Close code sent to a socket whose slot another device took over ("Listen here").
WS_TAKEN_OVER = 4001


async def _claim_slot(uid, websocket, takeover):
    """Registers the socket; with takeover, evicts the account's other sockets first."""
    evicted = []
    async with _active_ws_lock:
        holders = _active_ws_by_uid.setdefault(uid, [])
        if len(holders) >= MAX_WS_PER_USER:
            if not takeover:
                return False
            evicted = holders[:]
            holders.clear()
        holders.append(websocket)
    for other in evicted:
        try:
            await other.close(code=WS_TAKEN_OVER, reason="Taken over by another device")
        except Exception:
            pass
    return True


async def _release_slot(uid, websocket):
    async with _active_ws_lock:
        holders = _active_ws_by_uid.get(uid)
        if not holders:
            return
        if websocket in holders:
            holders.remove(websocket)
        if not holders:
            _active_ws_by_uid.pop(uid, None)


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    # Ordered by reading position so the sentence the listener needs next (or a
    # retried one) is never stuck behind sentences queued further ahead.
    queue = asyncio.PriorityQueue(maxsize=MAX_WS_QUEUE)
    queue_seq = itertools.count()
    state = {"active_session": -1, "current_workers": 0, "authenticated": False, "uid": None}
    worker_pool = {}
    ws_lock = asyncio.Lock()

    async def receiver():
        try:
            while True:
                msg = await websocket.receive_json()
                if not state["authenticated"]:
                    if msg.get("type") != "AUTH":
                        await websocket.close(code=1008, reason="Authentication required")
                        return
                    claims = _verify_bearer_token(f"Bearer {msg.get('token', '')}")
                    if claims is None:
                        await websocket.close(code=1008, reason="Invalid or expired authentication token")
                        return
                    uid = claims.get("uid")
                    if not await _claim_slot(uid, websocket, msg.get("takeover") is True):
                        await websocket.close(code=1013, reason="Too many active connections")
                        return
                    state["uid"] = uid
                    state["authenticated"] = True
                    async with ws_lock:
                        await websocket.send_json({"type": "AUTH_OK"})
                    continue

                if msg["type"] == "PREFETCH":
                    text_error = _validate_text_size(msg.get("text", ""))
                    if text_error:
                        async with ws_lock:
                            await websocket.send_json({
                                "type": "PREFETCH_FAILED",
                                "index": msg.get("index", -1),
                                "chapterIndex": msg.get("chapterIndex", 0),
                                "sessionId": msg.get("sessionId", -1),
                                "error": text_error.body.decode("utf-8") if hasattr(text_error, "body") else "Invalid text"
                            })
                        continue

                    sid = msg.get("sessionId", -1)
                    if sid > state["active_session"]:
                        state["active_session"] = sid
                        logger.info("New Active Session: %s", sid)
                        
                        while not queue.empty():
                            queue.get_nowait()
                        
                        try:
                            requested_workers = int(msg.get("numWorkers", NUM_WORKERS))
                        except (TypeError, ValueError):
                            requested_workers = NUM_WORKERS
                        requested_workers = max(1, min(requested_workers, MAX_WS_WORKERS))
                        logger.info("Aggressive Reset: Killing old workers, spawning %d new workers.", requested_workers)
                        
                        old_workers = list(worker_pool.values())
                        worker_pool.clear()
                        for task in old_workers:
                            task.cancel()
                        if old_workers:
                            try:
                                await asyncio.wait_for(
                                    asyncio.gather(*old_workers, return_exceptions=True),
                                    timeout=1.0,
                                )
                            except (asyncio.TimeoutError, TypeError):
                                pass
                        
                        state["current_workers"] = requested_workers
                        for i in range(requested_workers):
                            worker_pool[i] = asyncio.create_task(worker(i))
                        
                    if queue.full():
                        async with ws_lock:
                            await websocket.send_json({
                                "type": "PREFETCH_FAILED",
                                "index": msg.get("index", -1),
                                "chapterIndex": msg.get("chapterIndex", 0),
                                "sessionId": msg.get("sessionId", -1),
                                "error": "TTS queue is full; try again shortly"
                            })
                    else:
                        position = (msg.get("chapterIndex", 0), msg.get("index", 0))
                        await queue.put((position, next(queue_seq), msg))
                elif msg["type"] == "PING":
                    async with ws_lock:
                        await websocket.send_json({"type": "PONG"})
        except WebSocketDisconnect:
            pass
        except Exception as e:
            logger.error("WS Receiver Error: %s", e)

    async def send_parts(msg, sid, text, voice, rate, pitch, volume) -> bool:
        """Stream a sentence piece by piece. Returns False once the socket is
        gone so the worker can stop; synthesis errors propagate to the caller."""
        part = 0
        async for piece_chunks in synthesize_pieces(text, voice, rate, pitch, volume):
            if state["active_session"] > sid:
                return True
            metadata = [
                {
                    "start": c["offset"] / 10_000_000,
                    "duration": c["duration"] / 10_000_000,
                    "text": c["text"],
                }
                for c in piece_chunks if c["type"] == "WordBoundary"
            ]
            audio = b"".join(c["data"] for c in piece_chunks if c["type"] == "audio")
            try:
                async with ws_lock:
                    await websocket.send_json({
                        "type": "METADATA",
                        "index": msg["index"],
                        "chapterIndex": msg.get("chapterIndex", 0),
                        "sessionId": sid,
                        "part": part,
                        "metadata": metadata,
                    })
                    await websocket.send_bytes(audio)
            except (WebSocketDisconnect, RuntimeError):
                return False
            part += 1
        if state["active_session"] <= sid:
            try:
                async with ws_lock:
                    await websocket.send_json({
                        "type": "PREFETCH_DONE",
                        "index": msg["index"],
                        "chapterIndex": msg.get("chapterIndex", 0),
                        "sessionId": sid,
                        "parts": part,
                    })
            except (WebSocketDisconnect, RuntimeError):
                return False
        return True

    async def worker(worker_id: int):
        try:
            while True:
                _, _, msg = await queue.get()
                sid = msg.get("sessionId", -1)
                
                if sid < state["active_session"]:
                    logger.debug("[Worker %d] Skipping stale task: session %s < active %s", worker_id, sid, state['active_session'])
                    queue.task_done()
                    continue
                
                text = msg["text"]
                voice = msg["voice"]
                rate = msg.get("rate", "+0%")
                pitch = msg.get("pitch", "+0Hz")
                volume = msg.get("volume", "+0%")
                set_tts_options(msg.get("useProxy"), msg.get("gttsFallback"))
                
                logger.info("[Worker %d] Generating audio for index %s (Session %s)", worker_id, msg.get('index'), sid)
                
                try:
                    if msg.get("parts"):
                        # Progressive delivery: each piece is sent as soon as it is
                        # ready, so playback after a jump starts on the first piece
                        # instead of waiting for the whole paragraph.
                        if not await send_parts(msg, sid, text, voice, rate, pitch, volume):
                            break
                        continue

                    metadata = []
                    audio_data = bytearray()

                    async for chunk in synthesize_chunks(text, voice, rate, pitch, volume):
                        if state["active_session"] > sid:
                            logger.info("[Worker %d] Aborting mid-stream: new session detected (%s > %s)", worker_id, state['active_session'], sid)
                            break
                        
                        if chunk["type"] == "audio":
                            audio_data.extend(chunk["data"])
                        elif chunk["type"] == "WordBoundary":
                            metadata.append({
                                "start": chunk["offset"] / 10_000_000,
                                "duration": chunk["duration"] / 10_000_000,
                                "text": chunk["text"]
                            })
                    
                    if state["active_session"] <= sid:
                        try:
                            async with ws_lock:
                                await websocket.send_json({
                                    "type": "METADATA",
                                    "index": msg["index"],
                                    "chapterIndex": msg.get("chapterIndex", 0),
                                    "sessionId": sid,
                                    "metadata": metadata
                                })
                                await websocket.send_bytes(audio_data)
                                await websocket.send_json({
                                    "type": "PREFETCH_DONE",
                                    "index": msg["index"],
                                    "chapterIndex": msg.get("chapterIndex", 0),
                                    "sessionId": sid
                                })
                        except (WebSocketDisconnect, RuntimeError):
                            logger.info("[Worker %d] Send failed: Socket closed.", worker_id)
                            break
                except Exception as e:
                    logger.error("[Worker %d] Generation Error: %s", worker_id, e)
                    if state["active_session"] <= sid:
                        try:
                            async with ws_lock:
                                await websocket.send_json({
                                    "type": "PREFETCH_FAILED",
                                    "index": msg["index"],
                                    "chapterIndex": msg.get("chapterIndex", 0),
                                    "sessionId": sid,
                                    "error": str(e)
                                })
                        except Exception:
                            pass
                finally:
                    queue.task_done()
        except asyncio.CancelledError:
            logger.debug("[Worker %d] Worker task cancelled.", worker_id)
        except Exception as e:
            logger.error("[Worker %d] Worker Fatal Error: %s", worker_id, e)

    receiver_task = asyncio.create_task(receiver())
    
    done, pending = await asyncio.wait(
        [receiver_task],
        return_when=asyncio.FIRST_COMPLETED,
    )

    receiver_task.cancel()

    # Free the per-user slot before the slow worker teardown (cancelling
    # in-flight Edge streams can take seconds); otherwise the client's
    # immediate reconnect is refused with 1013 and loops into a stall reset.
    if state["uid"]:
        await _release_slot(state["uid"], websocket)

    remaining_workers = list(worker_pool.values())
    for w_task in remaining_workers:
        w_task.cancel()
    if remaining_workers:
        await asyncio.gather(*remaining_workers, return_exceptions=True)

    for task in pending:
        task.cancel()
