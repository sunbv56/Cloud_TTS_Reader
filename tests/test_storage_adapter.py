import os
import tempfile
import types
import unittest
import asyncio
import threading
from unittest.mock import patch

from storage_adapter import B2StorageBackend, _B2Blob
from main import (
    _build_segment_data,
    _detect_text_encoding,
    _get_or_download_legacy_source,
    _invalidate_legacy_source_cache,
    _run_blocking,
    _serialized_import_route,
    _should_segment_book,
    SEGMENT_CHAPTER_SIZE,
    SEGMENT_FORMAT_VERSION,
    partition_chapters,
    segment_blob_path,
    parse_chapter_at_index,
)


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


class _FlakyBody(_FakeBody):
    def __init__(self, payload):
        super().__init__(payload)
        self.failed = False

    def read(self, size=-1):
        if self._offset and not self.failed:
            self.failed = True
            from urllib3.exceptions import ProtocolError
            raise ProtocolError("connection broken", OSError("incomplete read"))
        return super().read(size)


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

    def test_interrupted_stream_retries_and_publishes_complete_file(self):
        bodies = [_FlakyBody(b"partial-complete"), _FakeBody(b"complete payload")]
        calls = []

        def get_object(**kwargs):
            calls.append(kwargs)
            return {"Body": bodies.pop(0), "ContentLength": len(b"complete payload")}

        backend = types.SimpleNamespace(
            client=types.SimpleNamespace(get_object=get_object),
            bucket_name="bucket",
            download_max_attempts=2,
            download_retry_backoff=0,
        )
        fd, path = tempfile.mkstemp(suffix=".txt")
        os.close(fd)
        try:
            _B2Blob(backend, "book.txt").download_to_filename(path)
            with open(path, "rb") as source:
                self.assertEqual(source.read(), b"complete payload")
            self.assertEqual(len(calls), 2)
        finally:
            if os.path.exists(path):
                os.remove(path)

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

    def test_legacy_chapter_reads_cache_source_and_only_parse_target(self):
        calls = []

        def download(path):
            calls.append(path)
            with open(path, "w", encoding="utf-8") as target:
                target.write("One\nFirst.\n===\nTwo\nSecond.\n===\nThree\nThird.\n")

        user_id = "cache-test-user"
        filename = "cache-test-book.txt"
        try:
            first_path, first_cached = _get_or_download_legacy_source(download, user_id, filename)
            second_path, second_cached = _get_or_download_legacy_source(download, user_id, filename)
            self.assertTrue(first_cached)
            self.assertTrue(second_cached)
            self.assertEqual(first_path, second_path)
            self.assertEqual(len(calls), 1)
            chapter = parse_chapter_at_index(second_path, 1)
            self.assertEqual(chapter["title"], "Two")
            self.assertEqual(chapter["content"], "Two\nSecond.")
        finally:
            _invalidate_legacy_source_cache(user_id, filename)

    def test_only_large_books_use_segment_navigation(self):
        self.assertFalse(_should_segment_book(1))
        self.assertFalse(_should_segment_book(200))
        self.assertTrue(_should_segment_book(201))
        self.assertFalse(_should_segment_book(0))

    def test_new_segments_use_versioned_fifty_chapter_layout(self):
        self.assertEqual(SEGMENT_CHAPTER_SIZE, 50)
        self.assertEqual(SEGMENT_FORMAT_VERSION, 2)
        self.assertEqual(
            len(partition_chapters([{"content": "x"}] * 101)), 3
        )
        self.assertIn("/segments/v2/seg_1.json", segment_blob_path("u", "s", 1))
        self.assertIn("/segments/seg_1.json", segment_blob_path("u", "s", 1, 0))

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
        with patch.dict(os.environ, settings, clear=False):
            backend = B2StorageBackend()
            client = backend.client
        self.assertEqual(client.connect_timeout, 7)
        self.assertEqual(client.read_timeout, 42)
        self.assertEqual(client.max_attempts, 2)

    def test_b2_diagnostic_info(self):
        settings = {
            "B2_ENDPOINT_URL": "https://example.invalid",
            "B2_BUCKET_NAME": "my-test-bucket",
            "B2_KEY_ID": "00583c8ddd791a90000000002",
            "B2_APPLICATION_KEY": "secret-key",
        }
        with patch.dict(os.environ, settings, clear=False), \
                patch("storage_adapter.S3LiteClient.head_bucket", lambda self, **kwargs: {}):
            backend = B2StorageBackend()
            info = backend.get_diagnostic_info()
            self.assertEqual(info["provider"], "b2")
            self.assertEqual(info["bucket"], "my-test-bucket")
            self.assertTrue(info["configured"])
            self.assertTrue(info["connected"])
            self.assertIn("00583c", info["key_id"])

    def test_firebase_diagnostic_info(self):
        from storage_adapter import FirebaseStorageBackend
        mock_fb = types.SimpleNamespace(bucket=lambda: types.SimpleNamespace(name="fb-bucket"))
        backend = FirebaseStorageBackend(mock_fb)
        info = backend.get_diagnostic_info()
        self.assertEqual(info["provider"], "firebase")
        self.assertTrue(info["configured"])
        self.assertTrue(info["connected"])
        self.assertEqual(info["bucket"], "fb-bucket")


if __name__ == "__main__":
    unittest.main()
