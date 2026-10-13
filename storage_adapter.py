"""Small storage compatibility layer for Firebase Storage and Backblaze B2.

The application historically used the Firebase Admin ``bucket/blob`` API.  This
module intentionally preserves that interface so the book/segment code can be
migrated without changing its storage paths or Firestore metadata.
"""

import base64
import datetime
import hashlib
import hmac
import http.client
import logging
import os
import re
import tempfile
import threading
import time
import urllib.parse
import uuid
import xml.etree.ElementTree as ET
from typing import Optional
from xml.sax.saxutils import escape as _xml_escape


logger = logging.getLogger("cloud_tts_reader.storage")


class S3Error(Exception):
    """S3 error response; `response` mirrors botocore's ClientError so the
    existing not-found checks keep working."""

    def __init__(self, status: int, code: str, message: str = ""):
        super().__init__(f"{status} {code}: {message}"[:300])
        self.response = {"ResponseMetadata": {"HTTPStatusCode": status}, "Error": {"Code": code, "Message": message}}


class _StreamingBody:
    """Response body that hands its keep-alive connection back once fully read."""

    def __init__(self, response, conn, release):
        self._response = response
        self._conn = conn
        self._release = release
        self._done = False

    def read(self, size=-1):
        data = self._response.read() if size is None or size < 0 else self._response.read(size)
        if not data:
            self._done = True
        return data

    def close(self):
        if self._conn is None:
            return
        conn, self._conn = self._conn, None
        if self._done and not self._response.will_close:
            self._release(conn)
        else:
            conn.close()


class S3LiteClient:
    """The handful of S3 calls the app makes, signed with AWS SigV4 over
    http.client. boto3/botocore cost ~21 MB of RSS on a 256 MB VM; this is a
    few hundred KB. Method names and return shapes follow boto3's client."""

    _RETRYABLE_STATUS = {429, 500, 502, 503, 504}
    _NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"

    def __init__(self, endpoint: str, region: str, key_id: str, secret: str,
                 connect_timeout: int = 10, read_timeout: int = 60, max_attempts: int = 3):
        parsed = urllib.parse.urlparse(endpoint)
        self._https = parsed.scheme != "http"
        self._host = parsed.netloc
        self.region = region or self._region_from_host(self._host)
        self._key_id = key_id
        self._secret = secret
        self.connect_timeout = connect_timeout
        self.read_timeout = read_timeout
        self.max_attempts = max_attempts
        self._local = threading.local()

    @staticmethod
    def _region_from_host(host: str) -> str:
        match = re.match(r"s3\.([a-z0-9-]+)\.backblazeb2\.com", host)
        return match.group(1) if match else "us-east-1"

    # -- connections -------------------------------------------------------
    def _new_conn(self):
        cls = http.client.HTTPSConnection if self._https else http.client.HTTPConnection
        conn = cls(self._host, timeout=self.connect_timeout)
        conn.connect()
        conn.sock.settimeout(self.read_timeout)
        return conn

    _IDLE_SECONDS = 15  # B2 drops idle keep-alive connections; don't reuse older ones

    def _take_conn(self):
        """Return (connection, reused). Idle pooled connections are dropped."""
        pooled = getattr(self._local, "conn", None)
        self._local.conn = None
        if pooled is not None:
            conn, last_used = pooled
            if time.monotonic() - last_used < self._IDLE_SECONDS:
                return conn, True
            conn.close()
        return self._new_conn(), False

    def _release_conn(self, conn):
        old = getattr(self._local, "conn", None)
        if old is not None:
            old[0].close()
        self._local.conn = (conn, time.monotonic())

    # -- signing -----------------------------------------------------------
    @staticmethod
    def _quote(value: str, safe: str = "-_.~") -> str:
        return urllib.parse.quote(value, safe=safe)

    def _sign(self, method: str, path: str, query: dict, headers: dict, payload_hash: str) -> dict:
        now = datetime.datetime.now(datetime.timezone.utc)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        date = now.strftime("%Y%m%d")
        headers = dict(headers)
        headers["host"] = self._host
        headers["x-amz-date"] = amz_date
        headers["x-amz-content-sha256"] = payload_hash
        lowered = {k.lower(): str(v).strip() for k, v in headers.items()}
        signed = sorted(lowered)
        canonical_headers = "".join(f"{k}:{lowered[k]}\n" for k in signed)
        canonical_query = "&".join(
            f"{self._quote(k)}={self._quote(str(v))}" for k, v in sorted(query.items())
        )
        canonical = "\n".join([method, path, canonical_query, canonical_headers, ";".join(signed), payload_hash])
        scope = f"{date}/{self.region}/s3/aws4_request"
        to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical.encode()).hexdigest()])
        key = ("AWS4" + self._secret).encode()
        for part in (date, self.region, "s3", "aws4_request"):
            key = hmac.new(key, part.encode(), hashlib.sha256).digest()
        signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
        headers["Authorization"] = (
            f"AWS4-HMAC-SHA256 Credential={self._key_id}/{scope}, "
            f"SignedHeaders={';'.join(signed)}, Signature={signature}"
        )
        return headers

    def _path(self, bucket: str, key: Optional[str] = None) -> str:
        path = "/" + self._quote(bucket)
        if key is not None:
            path += "/" + self._quote(key, safe="-_.~/")
        return path

    # -- request core ------------------------------------------------------
    def _request(self, method, bucket, key=None, query=None, headers=None, body=b"", body_file=None,
                 payload_hash=None, stream=False):
        query = query or {}
        path = self._path(bucket, key)
        url = path + ("?" + "&".join(
            f"{self._quote(k)}={self._quote(str(v))}" if v != "" else self._quote(k)
            for k, v in sorted(query.items())) if query else "")
        if payload_hash is None:
            payload_hash = hashlib.sha256(body).hexdigest()
        attempt = 0
        while attempt < self.max_attempts:
            attempt += 1
            conn = None
            reused = False
            got_response = False
            try:
                send_headers = self._sign(method, path, query, headers or {}, payload_hash)
                conn, reused = self._take_conn()
                if body_file is not None:
                    send_headers["Content-Length"] = str(os.path.getsize(body_file))
                    with open(body_file, "rb") as source:
                        conn.request(method, url, body=source, headers=send_headers)
                else:
                    if body or method in ("PUT", "POST"):
                        send_headers["Content-Length"] = str(len(body))
                    conn.request(method, url, body=body or None, headers=send_headers)
                response = conn.getresponse()
                got_response = True
                if response.status >= 300:
                    data = response.read()
                    if response.will_close:
                        conn.close()
                    else:
                        self._release_conn(conn)
                    conn = None
                    if response.status in self._RETRYABLE_STATUS and attempt < self.max_attempts:
                        time.sleep(0.5 * (2 ** (attempt - 1)))
                        continue
                    raise self._error(response.status, data)
                if stream:
                    return response, _StreamingBody(response, conn, self._release_conn)
                data = response.read()
                if response.will_close:
                    conn.close()
                else:
                    self._release_conn(conn)
                return response, data
            except (OSError, http.client.HTTPException) as exc:
                if conn is not None:
                    conn.close()
                if reused and not got_response:
                    # The server closed a pooled keep-alive connection before
                    # answering: retry at once on a fresh one, free of charge.
                    attempt -= 1
                    continue
                if attempt >= self.max_attempts:
                    raise
                logger.warning("s3_request_retry method=%s attempt=%s error=%s", method, attempt, type(exc).__name__)
                time.sleep(0.5 * (2 ** (attempt - 1)))

    def _error(self, status: int, data: bytes) -> S3Error:
        code, message = str(status), ""
        try:
            root = ET.fromstring(data)
            code = root.findtext("Code") or code
            message = root.findtext("Message") or ""
        except ET.ParseError:
            pass
        if status == 404 and code == "404":
            code = "NotFound"
        return S3Error(status, code, message)

    # -- boto3-compatible surface used by the app --------------------------
    def head_object(self, Bucket, Key):
        response, _ = self._request("HEAD", Bucket, Key)
        return {"ContentLength": int(response.getheader("Content-Length") or 0)}

    def head_bucket(self, Bucket):
        self._request("HEAD", Bucket)
        return {}

    def get_object(self, Bucket, Key):
        response, body = self._request("GET", Bucket, Key, stream=True)
        length = response.getheader("Content-Length")
        return {"Body": body, "ContentLength": int(length) if length is not None else None}

    def put_object(self, Bucket, Key, Body, ContentType=None):
        if isinstance(Body, str):
            Body = Body.encode("utf-8")
        headers = {"Content-Type": ContentType} if ContentType else {}
        self._request("PUT", Bucket, Key, headers=headers, body=Body)
        return {}

    def upload_file(self, Filename, Bucket, Key, ExtraArgs=None, Config=None):
        digest = hashlib.sha256()
        with open(Filename, "rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
        content_type = (ExtraArgs or {}).get("ContentType")
        headers = {"Content-Type": content_type} if content_type else {}
        self._request("PUT", Bucket, Key, headers=headers, body_file=Filename, payload_hash=digest.hexdigest())

    def delete_object(self, Bucket, Key):
        self._request("DELETE", Bucket, Key)
        return {}

    def delete_objects(self, Bucket, Delete):
        objects = "".join(f"<Object><Key>{_xml_escape(o['Key'])}</Key></Object>" for o in Delete["Objects"])
        quiet = "<Quiet>true</Quiet>" if Delete.get("Quiet") else ""
        body = f'<?xml version="1.0" encoding="UTF-8"?><Delete>{quiet}{objects}</Delete>'.encode("utf-8")
        headers = {
            "Content-Type": "application/xml",
            "Content-MD5": base64.b64encode(hashlib.md5(body).digest()).decode("ascii"),
        }
        self._request("POST", Bucket, query={"delete": ""}, headers=headers, body=body)
        return {}

    def list_objects_v2(self, Bucket, Prefix="", ContinuationToken=None):
        query = {"list-type": "2", "prefix": Prefix}
        if ContinuationToken:
            query["continuation-token"] = ContinuationToken
        _, data = self._request("GET", Bucket, query=query)
        root = ET.fromstring(data)
        ns = self._NS if root.tag.startswith(self._NS) else ""
        page = {
            "Contents": [{"Key": item.findtext(f"{ns}Key")} for item in root.findall(f"{ns}Contents")],
            "IsTruncated": (root.findtext(f"{ns}IsTruncated") or "false") == "true",
        }
        token = root.findtext(f"{ns}NextContinuationToken")
        if token:
            page["NextContinuationToken"] = token
        return page

    def get_paginator(self, operation):
        if operation != "list_objects_v2":
            raise ValueError(f"Unsupported paginator: {operation}")
        client = self

        class _Paginator:
            def paginate(self, Bucket, Prefix=""):
                token = None
                while True:
                    page = client.list_objects_v2(Bucket=Bucket, Prefix=Prefix, ContinuationToken=token)
                    yield page
                    token = page.get("NextContinuationToken")
                    if not page.get("IsTruncated") or not token:
                        return

        return _Paginator()


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
    provider_name = "firebase"

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

    def get_diagnostic_info(self) -> dict:
        """Return diagnostic info for health check endpoints."""
        bucket_name = os.getenv("FIREBASE_STORAGE_BUCKET", "").strip()
        info = {
            "provider": self.provider_name,
            "bucket": bucket_name or "(default)",
            "configured": bool(self._firebase_storage is not None),
            "connected": False,
            "error": None,
        }
        try:
            if self._firebase_storage is not None:
                # Test bucket accessibility
                b = self._firebase_storage.bucket()
                info["connected"] = True
                if hasattr(b, "name") and b.name:
                    info["bucket"] = b.name
        except Exception as exc:
            info["error"] = f"{type(exc).__name__}: {str(exc)}"
        return info


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
    provider_name = "b2"

    def __init__(self):
        self.bucket_name = os.getenv("B2_BUCKET_NAME", "").strip()
        self._client = None
        self._transfer_config = None
        self._client_error = None
        self._initialized = False

    def get_diagnostic_info(self) -> dict:
        """Return diagnostic info for health check endpoints."""
        endpoint = os.getenv("B2_ENDPOINT_URL", "").strip()
        key_id = os.getenv("B2_KEY_ID", "").strip()
        app_key = os.getenv("B2_APPLICATION_KEY", "").strip()
        masked_key = f"{key_id[:6]}...{key_id[-4:]}" if len(key_id) > 10 else ("(set)" if key_id else "(missing)")
        is_configured = bool(endpoint and self.bucket_name and key_id and app_key)
        info = {
            "provider": self.provider_name,
            "bucket": self.bucket_name or "(missing)",
            "endpoint": endpoint or "(missing)",
            "key_id": masked_key,
            "configured": is_configured,
            "connected": False,
            "error": None,
        }
        if is_configured:
            try:
                self.client.head_bucket(Bucket=self.bucket_name)
                info["connected"] = True
            except Exception as exc:
                info["error"] = f"{type(exc).__name__}: {str(exc)}"
        else:
            missing = []
            if not endpoint: missing.append("B2_ENDPOINT_URL")
            if not self.bucket_name: missing.append("B2_BUCKET_NAME")
            if not key_id: missing.append("B2_KEY_ID")
            if not app_key: missing.append("B2_APPLICATION_KEY")
            info["error"] = f"Missing required environment variables: {', '.join(missing)}"
        return info

    def _ensure_client(self):
        if self._initialized:
            return
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
        self._client = S3LiteClient(
            endpoint,
            region,
            key_id,
            application_key,
            connect_timeout=_int_env("B2_CONNECT_TIMEOUT_SECONDS", 10, 1, 60),
            read_timeout=_int_env("B2_READ_TIMEOUT_SECONDS", 60, 5, 300),
            max_attempts=max_attempts,
        )
        # Uploads are single streamed PUTs (no multipart thread pool), which
        # keeps memory flat on the 256 MB VM.
        self._transfer_config = None
        self._client_error = S3Error
        self._initialized = True

    @property
    def client(self):
        self._ensure_client()
        return self._client

    @property
    def transfer_config(self):
        self._ensure_client()
        return self._transfer_config

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
        error_name = type(exc).__name__
        if error_name in {"NoSuchKey", "NotFound", "404", "ResourceNotFoundError"}:
            return True
        if hasattr(exc, "response") and isinstance(exc.response, dict):
            status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
            code = exc.response.get("Error", {}).get("Code")
            if status == 404 or code in {"404", "NoSuchKey", "NotFound"}:
                return True
        try:
            self._ensure_client()
            if self._client_error and isinstance(exc, self._client_error):
                response = getattr(exc, "response", {})
                return (
                    response.get("ResponseMetadata", {}).get("HTTPStatusCode") == 404
                    or response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}
                )
        except Exception:
            pass
        return False


def get_storage_backend(firebase_storage_module):
    """Return the configured backend; Firebase remains the safe default."""
    if os.getenv("STORAGE_BACKEND", "firebase").strip().lower() == "b2":
        return B2StorageBackend()
    return FirebaseStorageBackend(firebase_storage_module)
