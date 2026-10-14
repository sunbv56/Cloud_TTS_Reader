import asyncio

import pytest

from app.services import tts_service


class _FakeCommunicate:
    """Scripted Edge stream: behaviours are consumed in launch order."""
    behaviours = []
    proxies = []

    def __init__(self, text, voice, proxy=None, **kwargs):
        self.behaviour = _FakeCommunicate.behaviours.pop(0)
        _FakeCommunicate.proxies.append(proxy)

    async def stream(self):
        kind, delay = self.behaviour
        await asyncio.sleep(delay)
        if kind == "fail":
            raise tts_service.edge_tts.exceptions.NoAudioReceived("no audio")
        yield {"type": "WordBoundary", "offset": 0, "duration": 1, "text": kind}
        yield {"type": "audio", "data": kind.encode()}


@pytest.fixture
def fake_edge(monkeypatch):
    monkeypatch.setattr(tts_service.edge_tts, "Communicate", _FakeCommunicate)
    monkeypatch.setattr(tts_service, "EDGE_TTS_HEDGE_SECONDS", 0.05)
    monkeypatch.setattr(tts_service, "EDGE_TTS_PROXY", "http://proxy:1")
    _FakeCommunicate.proxies = []
    return _FakeCommunicate


async def _collect():
    return [c async for c in tts_service.synthesize_chunks("xin chào", "vi-VN-HoaiMyNeural")]


def test_stalled_direct_attempt_is_overtaken_by_proxy(fake_edge):
    fake_edge.behaviours = [("slow", 5), ("fast", 0)]
    chunks = asyncio.run(asyncio.wait_for(_collect(), 2))
    assert [c["data"] for c in chunks if c["type"] == "audio"] == [b"fast"]
    assert fake_edge.proxies == [None, "http://proxy:1"]


def test_failed_attempt_is_replaced_immediately(fake_edge):
    fake_edge.behaviours = [("fail", 0), ("ok", 0)]
    chunks = asyncio.run(_collect())
    assert [c["type"] for c in chunks] == ["WordBoundary", "audio"]


def test_all_attempts_failing_raises(fake_edge, monkeypatch):
    monkeypatch.setattr(tts_service, "GTTS_FALLBACK", False)
    fake_edge.behaviours = [("fail", 0)] * tts_service.EDGE_TTS_ATTEMPTS
    with pytest.raises(tts_service.edge_tts.exceptions.NoAudioReceived):
        asyncio.run(_collect())


def test_split_for_tts_keeps_short_text_whole():
    assert tts_service.split_for_tts("Xin chào.", limit=50) == ["Xin chào."]


def test_split_for_tts_breaks_at_sentences_then_clauses():
    text = "Câu một ngắn. Câu hai cũng ngắn! " + "vế dài, " * 12 + "kết thúc."
    pieces = tts_service.split_for_tts(text, limit=40)
    assert all(len(p) <= 40 for p in pieces)
    assert " ".join(pieces).split() == text.split()


def test_split_for_tts_never_leaves_a_punctuation_only_piece():
    pieces = tts_service.split_for_tts("Một câu khá dài ở đây. ... !!!", limit=22)
    assert all(tts_service._HAS_SPEECH.search(p) for p in pieces)


def test_pieces_are_stitched_in_order_with_rebased_offsets(monkeypatch):
    calls = []

    async def fake_piece(text, *args):
        calls.append(text)
        await asyncio.sleep(0.05 if text.startswith("A") else 0)  # later piece finishes first
        yield {"type": "WordBoundary", "offset": 100, "duration": 1, "text": text[0]}
        yield {"type": "audio", "data": b"x" * 6000}  # 1s at 48 kbit/s

    monkeypatch.setattr(tts_service, "_synthesize_piece", fake_piece)
    monkeypatch.setattr(tts_service, "split_for_tts", lambda text: ["A1", "B2", "C3"])
    chunks = asyncio.run(_collect())
    words = [(c["text"], c["offset"]) for c in chunks if c["type"] == "WordBoundary"]
    assert words == [("A", 100), ("B", 10_000_100), ("C", 20_000_100)]
    assert sum(len(c["data"]) for c in chunks if c["type"] == "audio") == 18000


def test_split_for_tts_keeps_first_piece_short():
    text = "Mở đầu ngắn gọn. " * 6 + "Câu tiếp theo dài hơn một chút để kiểm tra. " * 6
    pieces = tts_service.split_for_tts(text, limit=120, first_limit=40)
    assert len(pieces[0]) <= 40
    assert all(len(p) <= 120 for p in pieces[1:])
    assert " ".join(pieces).split() == text.split()


def test_synthesize_pieces_yields_in_order_as_soon_as_ready(monkeypatch):
    async def fake_piece(text, *args):
        await asyncio.sleep({"A": 0.01, "B": 0.2, "C": 0}[text])
        yield {"type": "audio", "data": text.encode()}

    monkeypatch.setattr(tts_service, "_synthesize_piece", fake_piece)
    monkeypatch.setattr(tts_service, "split_for_tts", lambda text: ["A", "B", "C"])

    async def run():
        loop = asyncio.get_running_loop()
        start, seen = loop.time(), []
        async for piece in tts_service.synthesize_pieces("x", "v"):
            seen.append((piece[0]["data"], round(loop.time() - start, 1)))
        return seen

    seen = asyncio.run(run())
    assert [d for d, _ in seen] == [b"A", b"B", b"C"]
    assert seen[0][1] < 0.1  # first piece is not held back by the slow second one


def test_edge_connections_are_capped_and_released(fake_edge, monkeypatch):
    monkeypatch.setattr(tts_service, "EDGE_TTS_MAX_CONNECTIONS", 2)
    monkeypatch.setattr(tts_service, "EDGE_TTS_HEDGE_SECONDS", 10)
    live = {"now": 0, "peak": 0}

    class Counting(_FakeCommunicate):
        async def stream(self):
            live["now"] += 1
            live["peak"] = max(live["peak"], live["now"])
            try:
                await asyncio.sleep(0.02)
                yield {"type": "audio", "data": b"a"}
            finally:
                live["now"] -= 1

    monkeypatch.setattr(tts_service.edge_tts, "Communicate", Counting)
    fake_edge.behaviours = [("ok", 0)] * 6

    async def run():
        await asyncio.gather(*[_collect() for _ in range(6)])
        slots = tts_service._get_edge_slots()
        return slots._value

    assert asyncio.run(run()) == 2  # every slot was given back
    assert live["peak"] == 2


class _Forbidden(Exception):
    status = 403


def test_route_refused_with_403_is_benched(fake_edge, monkeypatch):
    monkeypatch.setattr(tts_service, "_route_blocked_until", {})
    monkeypatch.setattr(tts_service, "EDGE_TTS_HEDGE_SECONDS", 10)

    class DirectBlocked(_FakeCommunicate):
        async def stream(self):
            if _FakeCommunicate.proxies[-1] is None:
                raise _Forbidden("403, message='Invalid response status'")
            yield {"type": "audio", "data": b"via-proxy"}

    monkeypatch.setattr(tts_service.edge_tts, "Communicate", DirectBlocked)
    fake_edge.behaviours = [("ok", 0)] * 10

    asyncio.run(_collect())  # direct 403 -> proxy
    fake_edge.proxies = []
    asyncio.run(_collect())  # direct is benched now: straight to proxy
    assert fake_edge.proxies == ["http://proxy:1"]


def test_no_audio_failures_do_not_bench_a_route(fake_edge, monkeypatch):
    monkeypatch.setattr(tts_service, "_route_blocked_until", {})
    fake_edge.behaviours = [("fail", 0), ("ok", 0)]
    asyncio.run(_collect())
    assert tts_service._usable_routes() == [None, "http://proxy:1"]


def test_proxy_toggle_off_keeps_every_attempt_direct(fake_edge):
    fake_edge.behaviours = [("slow", 5), ("fast", 0)]

    async def run():
        tts_service.set_tts_options(use_proxy=False)
        return await _collect()

    asyncio.run(asyncio.wait_for(run(), 2))
    assert fake_edge.proxies == [None, None]


def test_gtts_toggle_overrides_server_default(fake_edge, monkeypatch):
    monkeypatch.setattr(tts_service, "GTTS_FALLBACK", False)
    monkeypatch.setattr(tts_service, "_gtts_bytes", lambda text, lang: b"gtts")
    fake_edge.behaviours = [("fail", 0)] * tts_service.EDGE_TTS_ATTEMPTS

    async def run():
        tts_service.set_tts_options(gtts_fallback=True)
        return await _collect()

    chunks = asyncio.run(run())
    assert [c["data"] for c in chunks if c["type"] == "audio"] == [b"gtts"]
