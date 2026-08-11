import os
import tempfile
import types
import unittest

from storage_adapter import _B2Blob


class _FakeBody:
    def __init__(self, payload):
        self._payload = payload
        self._offset = 0
        self.closed = False

    def read(self, size):
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


if __name__ == "__main__":
    unittest.main()
