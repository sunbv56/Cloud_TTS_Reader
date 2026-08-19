"""Small storage compatibility layer for Firebase Storage and Backblaze B2.

The application historically used the Firebase Admin ``bucket/blob`` API.  This
module intentionally preserves that interface so the book/segment code can be
migrated without changing its storage paths or Firestore metadata.
"""

import logging
import os
import tempfile
import time
import uuid
from typing import Optional


logger = logging.getLogger("cloud_tts_reader.storage")


def _int_env(name: str, default: int, minimum: int = 1, maximum: int = 300) -> int:
    """Read a bounded integer setting without allowing invalid client config."""
    try:
        value = int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


class _FirebaseBlob:
    def __init__(self, blob):
        self._blob = blob

    def exists(self):
        return self._blob.exists()

    def upload_from_filename(self, filename, content_type: Optional[str] = None):
        kwargs = {"content_type": content_type} if content_type else {}
        return self._blob.upload_from_filename(filename, **kwargs)

    def upload_from_string(self, data, content_type: Optional[str] = None):
        kwargs = {"content_type": content_type} if content_type else {}
        return self._blob.upload_from_string(data, **kwargs)

    def download_as_text(self):
        return self._blob.download_as_text()

    def download_as_bytes(self):
        return self._blob.download_as_bytes()

    def download_to_filename(self, filename):
        return self._blob.download_to_filename(filename)

    def delete(self):
        return self._blob.delete()


class FirebaseStorageBackend:
    def __init__(self, firebase_storage_module):
        self._firebase_storage = firebase_storage_module

    def bucket(self):
        return self

    def blob(self, path):
        return _FirebaseBlob(self._firebase_storage.bucket().blob(path))

    def list_keys(self, prefix):
        return [blob.name for blob in self._firebase_storage.bucket().list_blobs(prefix=prefix)]

    def delete_prefix(self, prefix):
        for key in self.list_keys(prefix):
            self.blob(key).delete()


def _is_retryable_stream_error(exc: Exception) -> bool:
    """Recognize transport failures without retrying auth/not-found errors."""
    names = set()
    current = exc
    while current is not None:
        names.add(type(current).__name__)
        current = current.__cause__ or current.__context__
    retryable_names = {
        "ConnectionError",
        "ConnectionClosedError",
        "ConnectTimeoutError",
        "EndpointConnectionError",
        "IncompleteRead",
        "ProtocolError",
        "ReadTimeoutError",
        "ResponseStreamingError",
        "SSLError",
    }
    if names & retryable_names:
        return True
    message = str(exc).lower()
    return any(fragment in message for fragment in (
        "connection broken",
        "connection reset",
        "incomplete read",
        "response stream",
        "timed out",
    ))


class _B2Blob:
    def __init__(self, backend, path):
        self._backend = backend
        self.path = path

    def exists(self):
        try:
            self._backend.client.head_object(
                Bucket=self._backend.bucket_name,
                Key=self.path,
            )
            return True
        except Exception as exc:
            if self._backend.is_not_found(exc):
                return False
            raise

    def upload_from_filename(self, filename, content_type: Optional[str] = None):
        extra_args = {"ContentType": content_type} if content_type else None
        self._backend.client.upload_file(
            filename,
            self._backend.bucket_name,
            self.path,
            ExtraArgs=extra_args or {},
            Config=self._backend.transfer_config,
        )

    def upload_from_string(self, data, content_type: Optional[str] = None):
        if isinstance(data, str):
            data = data.encode("utf-8")
        kwargs = {
            "Bucket": self._backend.bucket_name,
            "Key": self.path,
            "Body": data,
        }
        if content_type:
            kwargs["ContentType"] = content_type
        self._backend.client.put_object(**kwargs)

    def download_as_text(self):
        return self.download_as_bytes().decode("utf-8")

    def download_as_bytes(self):
        # Reuse the same atomic/retrying stream path as file downloads. This
        # covers segment recovery, export validation, and image reads too.
        fd, temp_path = tempfile.mkstemp(prefix="cloud-tts-read-")
        os.close(fd)
        try:
            self.download_to_filename(temp_path)
            with open(temp_path, "rb") as source:
                return source.read()
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)

    def download_to_filename(self, filename):
        """Download an object atomically, retrying interrupted response streams.

        S3-compatible providers can close a long response after some bytes have
        arrived. Retrying only the SDK request does not help in that case because
        the exception is raised later, while ``StreamingBody.read`` is running.
        Each attempt therefore writes to a unique temporary file and publishes it
        only after the complete Content-Length has been received.
        """
        max_attempts = max(1, int(getattr(self._backend, "download_max_attempts", 3)))
        backoff_base = float(getattr(self._backend, "download_retry_backoff", 0.5))
        parent = os.path.dirname(os.path.abspath(filename))
        os.makedirs(parent, exist_ok=True)

        for attempt in range(1, max_attempts + 1):
            temp_path = f"{filename}.download-{uuid.uuid4().hex}.tmp"
            response = None
            body = None
            bytes_read = 0
            started = time.monotonic()
            try:
                response = self._backend.client.get_object(
                    Bucket=self._backend.bucket_name,
                    Key=self.path,
                )
                body = response["Body"]
                expected_length = response.get("ContentLength")
                with open(temp_path, "wb") as target:
                    while chunk := body.read(1024 * 1024):
                        target.write(chunk)
                        bytes_read += len(chunk)
                if expected_length is not None and bytes_read != expected_length:
                    raise IOError(
                        f"Incomplete object download for {self.path}: "
                        f"received {bytes_read} of {expected_length} bytes"
                    )
                os.replace(temp_path, filename)
                logger.info(
                    "storage_download_complete key=%s attempt=%s bytes=%s elapsed_ms=%.1f",
                    self.path, attempt, bytes_read, (time.monotonic() - started) * 1000,
                )
                return
            except Exception as exc:
                if os.path.exists(temp_path):
                    try:
                        os.remove(temp_path)
                    except OSError:
                        logger.warning("storage_download_temp_cleanup_failed key=%s", self.path)
                retryable = _is_retryable_stream_error(exc)
                if not retryable or attempt >= max_attempts:
                    raise
                delay = backoff_base * (2 ** (attempt - 1))
                logger.warning(
                    "storage_download_retry key=%s attempt=%s/%s bytes=%s delay_s=%.2f error=%s",
                    self.path, attempt, max_attempts, bytes_read, delay, type(exc).__name__,
                )
                time.sleep(delay)
            finally:
                if body is not None:
                    body.close()

    def delete(self):
        return self._backend.client.delete_object(
            Bucket=self._backend.bucket_name,
            Key=self.path,
        )


class B2StorageBackend:
    def __init__(self):
        try:
            import boto3
            from botocore.config import Config
            from botocore.exceptions import ClientError
            from boto3.s3.transfer import TransferConfig
        except ImportError as exc:  # pragma: no cover - production dependency
            raise RuntimeError("boto3 is required when STORAGE_BACKEND=b2") from exc

        endpoint = os.getenv("B2_ENDPOINT_URL", "").strip()
        if endpoint and not endpoint.startswith(("http://", "https://")):
            endpoint = f"https://{endpoint}"
        self.bucket_name = os.getenv("B2_BUCKET_NAME", "").strip()
        key_id = os.getenv("B2_KEY_ID", "").strip()
        application_key = os.getenv("B2_APPLICATION_KEY", "").strip()
        if not endpoint or not self.bucket_name or not key_id or not application_key:
            raise RuntimeError(
                "B2 storage requires B2_ENDPOINT_URL, B2_BUCKET_NAME, "
                "B2_KEY_ID and B2_APPLICATION_KEY"
            )

        region = os.getenv("B2_REGION", "").strip() or None
        max_attempts = _int_env("B2_MAX_ATTEMPTS", 3, 1, 8)
        self.download_max_attempts = _int_env("B2_DOWNLOAD_MAX_ATTEMPTS", 3, 1, 8)
        try:
            self.download_retry_backoff = max(
                0.1, min(10.0, float(os.getenv("B2_DOWNLOAD_RETRY_BACKOFF_SECONDS", "0.5")))
            )
        except (TypeError, ValueError):
            self.download_retry_backoff = 0.5
        self.client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            region_name=region,
            aws_access_key_id=key_id,
            aws_secret_access_key=application_key,
            config=Config(
                connect_timeout=_int_env("B2_CONNECT_TIMEOUT_SECONDS", 10, 1, 60),
                read_timeout=_int_env("B2_READ_TIMEOUT_SECONDS", 60, 5, 300),
                retries={"max_attempts": max_attempts, "mode": "standard"},
            ),
        )
        # boto3's default S3Transfer uses 10 threads x 8 MiB parts. That is
        # safe for a large host, but it can consume most of a 256 MB Fly VM.
        self.transfer_config = TransferConfig(
            multipart_threshold=16 * 1024 * 1024,
            multipart_chunksize=4 * 1024 * 1024,
            max_concurrency=1,
            use_threads=False,
        )
        self._client_error = ClientError

    def bucket(self):
        return self

    def blob(self, path):
        return _B2Blob(self, path)

    def list_keys(self, prefix):
        paginator = self.client.get_paginator("list_objects_v2")
        keys = []
        for page in paginator.paginate(Bucket=self.bucket_name, Prefix=prefix):
            keys.extend(item["Key"] for item in page.get("Contents", []))
        return keys

    def delete_prefix(self, prefix):
        keys = self.list_keys(prefix)
        for offset in range(0, len(keys), 1000):
            batch = [{"Key": key} for key in keys[offset:offset + 1000]]
            self.client.delete_objects(
                Bucket=self.bucket_name,
                Delete={"Objects": batch, "Quiet": True},
            )

    def is_not_found(self, exc):
        if isinstance(exc, self._client_error):
            return exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode") == 404 or exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}
        return False


def get_storage_backend(firebase_storage_module):
    """Return the configured backend; Firebase remains the safe default."""
    if os.getenv("STORAGE_BACKEND", "firebase").strip().lower() == "b2":
        return B2StorageBackend()
    return FirebaseStorageBackend(firebase_storage_module)
