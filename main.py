import os
from dotenv import load_dotenv
load_dotenv()  # Load variables from .env if it exists

import re
import json
import asyncio
import edge_tts
import tempfile
import firebase_admin
from firebase_admin import credentials, storage, firestore
from fastapi import FastAPI, Request, Response, Form, UploadFile, File, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional

# Initialize Firebase Admin
firebase_admin_initialized = False
firebase_creds_json = os.getenv("FIREBASE_SERVICE_ACCOUNT")

if firebase_creds_json:
    try:
        # Strip potential single/double quotes from the beginning and end (common in Fly.io/Docker secrets)
        firebase_creds_json = firebase_creds_json.strip().strip("'").strip('"')
        creds_dict = json.loads(firebase_creds_json)
        cred = credentials.Certificate(creds_dict)
        firebase_admin.initialize_app(cred, {
            'storageBucket': os.getenv("FIREBASE_STORAGE_BUCKET")
        })
        print("Firebase Admin initialized via environment variable.")
        firebase_admin_initialized = True
    except Exception as e:
        print(f"Error initializing Firebase Admin with service account: {e}")
        # Log a snippet of the JSON to help domestic debugging (safely)
        if firebase_creds_json:
            print(f"Creds JSON starts with: {firebase_creds_json[:20]}...")
else:
    # Try default initialization (e.g. if running on GCP/GCE)
    try:
        firebase_admin.initialize_app(options={
            'storageBucket': os.getenv("FIREBASE_STORAGE_BUCKET")
        })
        print("Firebase Admin initialized via default credentials.")
        firebase_admin_initialized = True
    except Exception as e:
        print(f"Warning: Firebase Admin could not be initialized (local dev?). Storage features will be limited: {e}")

try:
    if firebase_admin_initialized:
        db_admin = firestore.client()
    else:
        db_admin = None
except Exception as e:
    print(f"Firestore client could not be initialized: {e}")
    db_admin = None

app = FastAPI()
NUM_WORKERS = 3  # Tăng số lượng worker nếu muốn nạp song song nhanh hơn

# Mount static files
static_dir = os.path.join(os.path.dirname(__file__), "static")
if not os.path.exists(static_dir):
    os.makedirs(static_dir)

# Helper functions for book parsing
def parse_chapters_from_file(file_path: str):
    """Memory-efficient chapter parsing by reading file line by line."""
    chapters = []
    current_raw_lines = []
    
    def process_raw_chapter(raw_lines):
        if not raw_lines: return
        raw_text = "".join(raw_lines).strip()
        if not raw_text: return
        
        lines = raw_text.split('\n')
        title = "Chương không tên"
        for line in lines:
            if line.strip():
                title = line.strip()
                break
        chapters.append({'title': title, 'content': raw_text})

    with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
        for line in f:
            if re.match(r'={3,}', line.strip()):
                process_raw_chapter(current_raw_lines)
                current_raw_lines = []
            else:
                current_raw_lines.append(line)
    
    # Process last chapter
    process_raw_chapter(current_raw_lines)
    
    # Handle empty case
    if not chapters:
        # Check if file has any content
        with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
            full_text = f.read(1000).strip() # just a peek
            if full_text:
                # If no delimiters found, treat entire file as one chapter
                with open(file_path, 'r', encoding='utf-8', errors='ignore') as f2:
                    content = f2.read().strip()
                    if content:
                        chapters.append({'title': "Mở đầu", 'content': content})
    return chapters

def split_text_into_chunks(text: str, max_chars: int = 500):
    chunks = []
    # Optimization: Use splitlines() to avoid unnecessary string copies
    for line in text.splitlines():
        line = line.strip()
        if not line: continue
        if len(line) <= max_chars:
            chunks.append(line)
        else:
            # Keep regex for sentence splitting
            sentences = re.split(r'(?<=[.!?])\s+', line)
            temp_chunk = ""
            for sentence in sentences:
                if len(temp_chunk) + len(sentence) > max_chars:
                    if temp_chunk: chunks.append(temp_chunk.strip())
                    temp_chunk = sentence
                else:
                    temp_chunk += " " + sentence if temp_chunk else sentence
            if temp_chunk: chunks.append(temp_chunk.strip())
    
    # Optimization: Use regex search instead of manual iteration for alphanumeric check
    alnum_regex = re.compile(r'\w')
    valid_chunks = [c for c in chunks if alnum_regex.search(c)]
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
    # Memory optimization: Stream upload to a temporary file
    with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as tmp:
        while chunk := await file.read(1024 * 1024): # 1MB chunks
            tmp.write(chunk)
        tmp_path = tmp.name

    try:
        chapters = parse_chapters_from_file(tmp_path)
        
        # Optimization: Generate metadata in a single pass and remove redundant processed_chapters loop
        chapters_metadata = []
        for chap in chapters:
            sentences = split_text_into_chunks(chap['content'])
            chapters_metadata.append({
                "title": chap['title'],
                "count": len(sentences)
            })

        return JSONResponse({
            "title": file.filename.replace(".txt", ""),
            "chapters": chapters_metadata
        })
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

@app.post("/api/get-chapter-sentences")
async def get_chapter_sentences(
    userId: str = Form(...),
    filename: str = Form(...),
    chapterIndex: int = Form(...)
):
    """Memory-efficiently fetch sentences for a specific chapter only."""
    if not firebase_admin_initialized:
        return JSONResponse({"error": "Firebase Admin not initialized on server. Check credentials."}, status_code=500)

    try:
        bucket = storage.bucket()
        blob_path = f"users/{userId}/files/{filename}"
        blob = bucket.blob(blob_path)
        
        if not blob.exists():
            return JSONResponse({"error": "File not found"}, status_code=404)

        with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as tmp:
            tmp_path = tmp.name
            blob.download_to_filename(tmp_path)
        
        try:
            chapters = parse_chapters_from_file(tmp_path)
            if 0 <= chapterIndex < len(chapters):
                sentences = split_text_into_chunks(chapters[chapterIndex]['content'])
                return JSONResponse({"sentences": sentences})
            else:
                return JSONResponse({"error": "Chapter index out of range"}, status_code=400)
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

@app.get("/api/firebase-config")
async def get_firebase_config():
    # Helper to get env but strip potential quotes
    def get_env_safe(key):
        val = os.getenv(key, "")
        if val:
            return val.strip().strip("'").strip('"')
        return ""

    return {
        "apiKey": get_env_safe("FIREBASE_API_KEY"),
        "authDomain": get_env_safe("FIREBASE_AUTH_DOMAIN"),
        "projectId": get_env_safe("FIREBASE_PROJECT_ID"),
        "storageBucket": get_env_safe("FIREBASE_STORAGE_BUCKET"),
        "messagingSenderId": get_env_safe("FIREBASE_MESSAGING_SENDER_ID"),
        "appId": get_env_safe("FIREBASE_APP_ID"),
        "measurementId": get_env_safe("FIREBASE_MEASUREMENT_ID")
    }

@app.post("/api/append-chapter")
async def append_chapter(
    userId: str = Form(...),
    bookId: str = Form(...),
    filename: str = Form(...),
    file: UploadFile = File(...)
):
    """Memory-efficient chapter appending on the server."""
    if not firebase_admin_initialized:
        return JSONResponse({"error": "Firebase Admin not initialized on server. Check credentials."}, status_code=500)

    try:
        bucket = storage.bucket()
    except Exception as e:
        return JSONResponse({"error": f"Could not access storage bucket: {e}"}, status_code=500)

    blob_path = f"users/{userId}/files/{filename}"
    blob = bucket.blob(blob_path)

    with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as tmp:
        tmp_path = tmp.name
        try:
            # 1. Download existing if it exists
            if blob.exists():
                blob.download_to_filename(tmp_path)
                # Ensure there's a newline separator
                with open(tmp_path, "a", encoding="utf-8") as f:
                    f.write("\n\n")
            
            # 2. Append new content
            with open(tmp_path, "ab") as f:
                while chunk := await file.read(1024 * 1024):
                    f.write(chunk)
                    
            # 3. Re-upload merged file
            blob.upload_from_filename(tmp_path)
            
            # 4. Parse the merged result to get new metadata
            chapters = parse_chapters_from_file(tmp_path)
            chapters_metadata = []
            for chap in chapters:
                sentences = split_text_into_chunks(chap['content'])
                chapters_metadata.append({
                    "title": chap['title'],
                    "count": len(sentences)
                })
                
            return JSONResponse({
                "title": filename.replace(".txt", ""),
                "chapters": chapters_metadata
            })
        except Exception as e:
            print(f"Error in append_chapter processing: {e}")
            return JSONResponse({"error": str(e)}, status_code=500)
        finally:
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except:
                    pass

@app.post("/api/delete-chapters")
async def delete_chapters(
    userId: str = Form(...),
    bookId: str = Form(...),
    filename: str = Form(...),
    indices: str = Form(...) # JSON string of list of ints [0, 2, 5]
):
    """Memory-efficient multi-chapter deletion on the server."""
    if not firebase_admin_initialized:
        return JSONResponse({"error": "Firebase Admin not initialized on server. Check credentials."}, status_code=500)

    try:
        bucket = storage.bucket()
    except Exception as e:
        return JSONResponse({"error": f"Could not access storage bucket: {e}"}, status_code=500)

    blob_path = f"users/{userId}/files/{filename}"
    blob = bucket.blob(blob_path)

    if not blob.exists():
        return JSONResponse({"error": "File not found"}, status_code=404)

    try:
        target_indices = json.loads(indices)
        if not isinstance(target_indices, list):
            return JSONResponse({"error": "Indices must be a JSON array"}, status_code=400)
        # Sort descending so we can pop without shifting remaining target indices
        target_indices.sort(reverse=True)
    except Exception as e:
        return JSONResponse({"error": f"Invalid indices format: {e}"}, status_code=400)

    with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as tmp:
        tmp_path = tmp.name
        try:
            blob.download_to_filename(tmp_path)
            
            # 1. Parse into chapters
            chapters = parse_chapters_from_file(tmp_path)
            
            # 2. Remove chapters
            for idx in target_indices:
                if 0 <= idx < len(chapters):
                    chapters.pop(idx)
                else:
                    print(f"Warning: Index {idx} out of range for deletion.")
            
            # 3. Reconstruct file
            with open(tmp_path, "w", encoding="utf-8") as f:
                for i, chap in enumerate(chapters):
                    if i > 0:
                        f.write("\n\n===\n\n")
                    f.write(chap['content'])
                    
            # 4. Re-upload
            blob.upload_from_filename(tmp_path)
            
            chapters_metadata = []
            for chap in chapters:
                # We need counts for progress tracking
                sentences = split_text_into_chunks(chap['content'])
                chapters_metadata.append({
                    "title": chap['title'],
                    "count": len(sentences)
                })

            return JSONResponse({
                "title": filename.replace(".txt", ""),
                "chapters": chapters_metadata
            })
        except Exception as e:
            print(f"Error in delete_chapters processing: {e}")
            return JSONResponse({"error": str(e)}, status_code=500)
        finally:
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except:
                    pass

@app.post("/api/get-chapter-content")
async def get_chapter_content(
    userId: str = Form(...),
    filename: str = Form(...),
    chapterIndex: int = Form(...)
):
    """Retrieve raw text content of a specific chapter."""
    if not firebase_admin_initialized:
        return JSONResponse({"error": "Firebase Admin not initialized"}, status_code=500)

    try:
        bucket = storage.bucket()
        blob_path = f"users/{userId}/files/{filename}"
        blob = bucket.blob(blob_path)
        
        if not blob.exists():
            return JSONResponse({"error": "File not found"}, status_code=404)

        with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as tmp:
            tmp_path = tmp.name
            blob.download_to_filename(tmp_path)
        
        try:
            chapters = parse_chapters_from_file(tmp_path)
            if 0 <= chapterIndex < len(chapters):
                return JSONResponse({"content": chapters[chapterIndex]['content']})
            else:
                return JSONResponse({"error": "Chapter index out of range"}, status_code=400)
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

@app.post("/api/update-chapter")
async def update_chapter(
    userId: str = Form(...),
    bookId: str = Form(...),
    filename: str = Form(...),
    chapterIndex: int = Form(...),
    newContent: str = Form(...)
):
    """Update raw text content of a specific chapter and re-upload."""
    if not firebase_admin_initialized:
        return JSONResponse({"error": "Firebase Admin not initialized"}, status_code=500)

    try:
        bucket = storage.bucket()
        blob_path = f"users/{userId}/files/{filename}"
        blob = bucket.blob(blob_path)
        
        if not blob.exists():
            return JSONResponse({"error": "File not found"}, status_code=404)

        with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as tmp:
            tmp_path = tmp.name
            blob.download_to_filename(tmp_path)
        
        try:
            chapters = parse_chapters_from_file(tmp_path)
            if 0 <= chapterIndex < len(chapters):
                # Update the chapter content
                chapters[chapterIndex]['content'] = newContent
                
                # Reconstruct file
                with open(tmp_path, "w", encoding="utf-8") as f:
                    for i, chap in enumerate(chapters):
                        if i > 0:
                            f.write("\n\n===\n\n")
                        f.write(chap['content'])
                
                # Re-upload
                blob.upload_from_filename(tmp_path)
                
                # Return updated metadata for this chapter
                # Re-parse the updated content to get new title and sentences
                updated_lines = newContent.split('\n')
                new_title = "Chương không tên"
                for line in updated_lines:
                    if line.strip():
                        new_title = line.strip()
                        break
                
                sentences = split_text_into_chunks(newContent)
                return JSONResponse({
                    "title": new_title,
                    "count": len(sentences),
                    "sentences": sentences
                })
            else:
                return JSONResponse({"error": "Chapter index out of range"}, status_code=400)
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

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

@app.post("/api/download-chapters")
async def download_chapters(req: ChapterDownloadRequest):
    """Generate a single MP3 file from selected chapters and stream as download."""
    indices = [c.chapterIndex for c in req.chapters]
    xx = min(indices) + 1  # 1-indexed for display
    yy = max(indices) + 1
    
    # Sanitize book title for filename
    safe_title = re.sub(r'[^\w\s-]', '', req.bookTitle).strip().replace(' ', '_')
    filename = f"{safe_title}_{xx:02d}_{yy:02d}.mp3"
    
    async def generate_audio():
        for chapter in req.chapters:
            # Join all sentences into full chapter text for a single TTS call
            full_text = "\n".join(chapter.sentences)
            print(f"[Download] Generating chapter: {chapter.title} ({len(full_text)} chars)")
            try:
                communicate = edge_tts.Communicate(
                    full_text, req.voice,
                    rate=req.rate, pitch=req.pitch, volume=req.volume
                )
                async for chunk in communicate.stream():
                    if chunk["type"] == "audio":
                        yield chunk["data"]
            except Exception as e:
                print(f"[Download] TTS Error for chapter {chapter.title}: {e}")
                continue
    
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"'
    }
    
    return StreamingResponse(generate_audio(), media_type="audio/mpeg", headers=headers)

# Main route for index.html
@app.get("/")
async def get_index():
    return FileResponse(os.path.join(static_dir, "index.html"))

@app.get("/api/ping")
async def api_ping():
    return {"status": "ok", "message": "Keep-alive ping received"}

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
