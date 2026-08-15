import os
import tempfile
import types
import unittest
import asyncio
import threading
from unittest.mock import patch

from storage_adapter import B2StorageBackend, _B2Blob
from main import _build_segment_data, _detect_text_encoding, _run_blocking, _serialized_import_route


class _FakeBody:
    def __init__(self, payload):
        self._payload = payload
        self._offset = 0
        self.closed = False

    def read(self, size=-1):
        if size < 0:
            size = len(self._payload) - self._offset
        chunk = self._payload[self._offset:self._offset + size]
        self._offset += len(chunk)
        return chunk

    def close(self):
        self.closed = True


class B2DownloadTest(unittest.TestCase):
    def test_download_to_filename_closes_response_body(self):
        body = _FakeBody(b"chapter text")
        client = types.SimpleNamespace(
            get_object=lambda **kwargs: {"Body": body}
        )
        backend = types.SimpleNamespace(client=client, bucket_name="bucket")
        fd, path = tempfile.mkstemp(suffix=".txt")
        os.close(fd)
        try:
            _B2Blob(backend, "book.txt").download_to_filename(path)
            with open(path, "rb") as source:
                self.assertEqual(source.read(), b"chapter text")
            self.assertTrue(body.closed)
            os.remove(path)
        finally:
            if os.path.exists(path):
                os.remove(path)

    def test_memory_downloads_close_response_body(self):
        for method_name, expected in (("download_as_text", "chapter text"), ("download_as_bytes", b"chapter text")):
            body = _FakeBody(b"chapter text")
            client = types.SimpleNamespace(get_object=lambda **kwargs: {"Body": body})
            backend = types.SimpleNamespace(client=client, bucket_name="bucket")
            result = getattr(_B2Blob(backend, "book.txt"), method_name)()
            self.assertEqual(result, expected)
            self.assertTrue(body.closed)

    def test_utf8_detection_handles_multibyte_character_at_sample_boundary(self):
        fd, path = tempfile.mkstemp(suffix=".txt")
        os.close(fd)
        try:
            with open(path, "wb") as target:
                target.write(b"a" * 65538)
                target.write("ế".encode("utf-8"))
            self.assertEqual(_detect_text_encoding(path), "utf-8")
        finally:
            if os.path.exists(path):
                os.remove(path)


class ImportRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def test_blocking_work_runs_off_event_loop(self):
        event_loop_thread = threading.get_ident()
        worker_thread = await _run_blocking("test", threading.get_ident)
        self.assertNotEqual(event_loop_thread, worker_thread)

    async def test_second_heavy_import_is_rejected_with_retry_hint(self):
        started = asyncio.Event()
        release = asyncio.Event()

        async def route():
            started.set()
            await release.wait()
            return "ok"

        guarded = _serialized_import_route(route)
        first = asyncio.create_task(guarded())
        await started.wait()
        second = await guarded()
        self.assertEqual(second.status_code, 429)
        self.assertIn("retry-after", second.headers)
        release.set()
        self.assertEqual(await first, "ok")

    def test_segment_builder_preserves_sentence_counts(self):
        data, counts = _build_segment_data([
            {"title": "One", "content": "First sentence.\nSecond sentence."},
            {"title": "Two", "content": "Third sentence."},
        ])
        self.assertEqual([item["title"] for item in data], ["One", "Two"])
        self.assertEqual(counts, [2, 1])

    def test_b2_client_has_bounded_timeout_and_retries(self):
        settings = {
            "B2_ENDPOINT_URL": "https://example.invalid",
            "B2_BUCKET_NAME": "bucket",
            "B2_KEY_ID": "key",
            "B2_APPLICATION_KEY": "secret",
            "B2_CONNECT_TIMEOUT_SECONDS": "7",
            "B2_READ_TIMEOUT_SECONDS": "42",
            "B2_MAX_ATTEMPTS": "2",
        }
        with patch.dict(os.environ, settings, clear=False), patch("boto3.client") as client:
            B2StorageBackend()
        config = client.call_args.kwargs["config"]
        self.assertEqual(config.connect_timeout, 7)
        self.assertEqual(config.read_timeout, 42)
        self.assertEqual(config.retries["max_attempts"], 2)
        self.assertEqual(config.retries["mode"], "standard")

if __name__ == "__main__":
    unittest.main()
