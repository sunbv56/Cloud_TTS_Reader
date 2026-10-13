import asyncio

from fastapi.testclient import TestClient

from app.routers import ws_tts
from app.server import create_app
from app.services import tts_service


def test_ws_streams_parts_then_done(monkeypatch):
    async def fake_piece(text, *args):
        await asyncio.sleep(0)
        yield {"type": "WordBoundary", "offset": 0, "duration": 1_000_000, "text": text[:3]}
        yield {"type": "audio", "data": text.encode()}

    monkeypatch.setattr(tts_service, "_synthesize_piece", fake_piece)
    monkeypatch.setattr(tts_service, "split_for_tts", lambda text: ["one", "two", "three"])
    monkeypatch.setattr(ws_tts, "_verify_bearer_token", lambda header: {"uid": "u1"})

    with TestClient(create_app()).websocket_connect("/ws") as ws:
        ws.send_json({"type": "AUTH", "token": "t"})
        assert ws.receive_json()["type"] == "AUTH_OK"
        ws.send_json({"type": "PREFETCH", "index": 4, "chapterIndex": 1, "text": "x",
                      "voice": "v", "sessionId": 1, "numWorkers": 1, "parts": True})
        received = []
        for _ in range(3):
            meta = ws.receive_json()
            received.append((meta["type"], meta["part"], ws.receive_bytes()))
        done = ws.receive_json()

    assert received == [("METADATA", 0, b"one"), ("METADATA", 1, b"two"), ("METADATA", 2, b"three")]
    assert done == {"type": "PREFETCH_DONE", "index": 4, "chapterIndex": 1, "sessionId": 1, "parts": 3}


def test_reconnect_is_accepted_while_old_workers_are_still_tearing_down(monkeypatch):
    async def slow_piece(text, *args):
        try:
            await asyncio.sleep(30)
        finally:
            await asyncio.sleep(0.5)  # slow cancellation, like closing an Edge stream
        yield {"type": "audio", "data": b""}

    monkeypatch.setattr(tts_service, "_synthesize_piece", slow_piece)
    monkeypatch.setattr(ws_tts, "_verify_bearer_token", lambda header: {"uid": "u2"})
    client = TestClient(create_app())

    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "AUTH", "token": "t"})
        assert ws.receive_json()["type"] == "AUTH_OK"
        ws.send_json({"type": "PREFETCH", "index": 0, "chapterIndex": 0, "text": "x",
                      "voice": "v", "sessionId": 1, "numWorkers": 1, "parts": True})

    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "AUTH", "token": "t"})
        assert ws.receive_json()["type"] == "AUTH_OK"
