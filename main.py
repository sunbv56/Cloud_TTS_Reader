import os
from dotenv import load_dotenv
load_dotenv()  # Load variables from .env if it exists

import re
import json
import asyncio
import edge_tts
from fastapi import FastAPI, Request, Response, Form, UploadFile, File, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional

app = FastAPI()
NUM_WORKERS = 3  # Tăng số lượng worker nếu muốn nạp song song nhanh hơn

# Mount static files
static_dir = os.path.join(os.path.dirname(__file__), "static")
if not os.path.exists(static_dir):
    os.makedirs(static_dir)

# Helper functions for book parsing
def parse_chapters(text: str):
    raw_chapters = re.split(r'={3,}', text)
    chapters = []
    for raw in raw_chapters:
        raw = raw.strip()
        if not raw: continue
        lines = raw.split('\n')
        title = "Chương không tên"
        for line in lines:
            if line.strip():
                title = line.strip()
                break
        chapters.append({'title': title, 'content': raw})
    if not chapters and text.strip():
        chapters.append({'title': "Mở đầu", 'content': text.strip()})
    return chapters

def split_text_into_chunks(text: str, max_chars: int = 800):
    chunks = []
    lines = text.replace('\r\n', '\n').split('\n')
    for line in lines:
        line = line.strip()
        if not line: continue
        if len(line) <= max_chars:
            chunks.append(line)
        else:
            sentences = re.split(r'(?<=[.!?])\s+', line)
            temp_chunk = ""
            for sentence in sentences:
                if len(temp_chunk) + len(sentence) > max_chars:
                    if temp_chunk: chunks.append(temp_chunk.strip())
                    temp_chunk = sentence
                else:
                    temp_chunk += " " + sentence if temp_chunk else sentence
            if temp_chunk: chunks.append(temp_chunk.strip())
    
    valid_chunks = [c for c in chunks if any(char.isalnum() for char in c)]
    return valid_chunks

# API Endpoints
@app.get("/stream/audio")
async def stream_audio(text: str, voice: str, rate: str = "+0%", pitch: str = "+0Hz", volume: str = "+0%"):
    # Format settings for edge-tts
    # rate: +50%, -10%, etc.
    # pitch: +5Hz, -5Hz, etc.
    # volume: +10%, -10%, etc.
    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, volume=volume)
    
    async def audio_generator():
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                yield chunk["data"]
    
    return StreamingResponse(audio_generator(), media_type="audio/mpeg")

@app.get("/stream/metadata")
async def stream_metadata(text: str, voice: str, rate: str = "+0%", pitch: str = "+0Hz", volume: str = "+0%"):
    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, volume=volume)
    metadata = []
    async for chunk in communicate.stream():
        if chunk["type"] == "WordBoundary":
            metadata.append({
                "start": chunk["offset"] / 10_000_000, # Convert 100ns to seconds
                "duration": chunk["duration"] / 10_000_000,
                "text": chunk["text"]
            })
    return JSONResponse(metadata)

@app.post("/api/parse-book")
async def parse_book(file: UploadFile = File(...)):
    content = await file.read()
    text = content.decode("utf-8")
    chapters = parse_chapters(text)
    
    processed_chapters = []
    for chap in chapters:
        sentences = split_text_into_chunks(chap['content'])
        processed_chapters.append({
            "title": chap['title'],
            "sentences": sentences
        })
        
    return JSONResponse({
        "title": file.filename.replace(".txt", ""),
        "chapters": processed_chapters
    })

@app.get("/api/firebase-config")
async def get_firebase_config():
    return {
        "apiKey": os.getenv("FIREBASE_API_KEY", ""),
        "authDomain": os.getenv("FIREBASE_AUTH_DOMAIN", ""),
        "projectId": os.getenv("FIREBASE_PROJECT_ID", ""),
        "storageBucket": os.getenv("FIREBASE_STORAGE_BUCKET", ""),
        "messagingSenderId": os.getenv("FIREBASE_MESSAGING_SENDER_ID", ""),
        "appId": os.getenv("FIREBASE_APP_ID", ""),
        "measurementId": os.getenv("FIREBASE_MEASUREMENT_ID", "")
    }

# Main route for index.html
@app.get("/")
async def get_index():
    return FileResponse(os.path.join(static_dir, "index.html"))

# Serving static files
app.mount("/static", StaticFiles(directory=static_dir), name="static")

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    queue = asyncio.Queue()
    state = {"active_session": -1, "current_workers": 0}
    worker_pool = {} # worker_id -> Task
    ws_lock = asyncio.Lock()

    async def receiver():
        try:
            while True:
                msg = await websocket.receive_json()
                if msg["type"] == "PREFETCH":
                    sid = msg.get("sessionId", -1)
                    if sid > state["active_session"]:
                        state["active_session"] = sid
                        print(f"New Active Session: {sid}")
                        # Immediately purge the queue of stale pending tasks
                        while not queue.empty():
                            queue.get_nowait()
                        
                        requested_workers = msg.get("numWorkers", NUM_WORKERS)
                        print(f"Aggressive Reset: Killing old workers, spawning {requested_workers} new workers.")
                        
                        # Aggressively kill ALL current workers to abort any stuck network requests
                        for task in worker_pool.values():
                            task.cancel()
                        worker_pool.clear()
                        
                        # Respawn the exact number of requested workers fresh
                        state["current_workers"] = requested_workers
                        for i in range(requested_workers):
                            worker_pool[i] = asyncio.create_task(worker(i))
                        
                    await queue.put(msg)
                elif msg["type"] == "PING":
                    async with ws_lock:
                        await websocket.send_json({"type": "PONG"})
        except WebSocketDisconnect:
            pass
        except Exception as e:
            print(f"WS Receiver Error: {e}")

    async def worker(worker_id: int):
        try:
            while True:
                msg = await queue.get()
                sid = msg.get("sessionId", -1)
                
                # Immediate check: if task is from a stale session, skip
                if sid < state["active_session"]:
                    print(f"[Worker {worker_id}] Skipping stale task: session {sid} < active {state['active_session']}")
                    queue.task_done()
                    continue
                
                text = msg["text"]
                voice = msg["voice"]
                rate = msg.get("rate", "+0%")
                pitch = msg.get("pitch", "+0Hz")
                volume = msg.get("volume", "+0%")
                
                print(f"[Worker {worker_id}] Generating audio for index {msg['index']} (Session {sid})")
                
                try:
                    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, volume=volume)
                    metadata = []
                    audio_data = b""

                    async for chunk in communicate.stream():
                        # CANCEL MID-STREAM instantly if a new session starts
                        if state["active_session"] > sid:
                            print(f"[Worker {worker_id}] Aborting mid-stream: new session detected ({state['active_session']} > {sid})")
                            break
                        
                        if chunk["type"] == "audio":
                            audio_data += chunk["data"]
                        elif chunk["type"] == "WordBoundary":
                            metadata.append({
                                "start": chunk["offset"] / 10_000_000,
                                "duration": chunk["duration"] / 10_000_000,
                                "text": chunk["text"]
                            })
                    
                    # Final check before sending (might have been aborted mid-stream)
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
                            print(f"[Worker {worker_id}] Send failed: Socket closed.")
                            break
                except Exception as e:
                    print(f"[Worker {worker_id}] Generation Error: {e}")
                finally:
                    queue.task_done()
        except asyncio.CancelledError:
            print(f"[Worker {worker_id}] Worker task cancelled.")
        except Exception as e:
            print(f"[Worker {worker_id}] Worker Fatal Error: {e}")

    receiver_task = asyncio.create_task(receiver())
    # Initial workers will be spawned by the first PREFETCH message in receiver()
    
    # Wait for either the receiver (disconnect/ping) or any task to finish
    # We now check worker_pool values for the wait
    done, pending = await asyncio.wait(
        [receiver_task],
        return_when=asyncio.FIRST_COMPLETED,
    )

    # Cleanup: cancel receiver and all workers in pool
    receiver_task.cancel()
    for w_task in worker_pool.values():
        w_task.cancel()

    # Cancel whatever is left (usually the worker)
    for task in pending:
        task.cancel()

# Supress specific 404s for common devtools/noise paths
@app.get("/.well-known/appspecific/com.chrome.devtools.json")
async def suppress_devtools_404():
    return {}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
