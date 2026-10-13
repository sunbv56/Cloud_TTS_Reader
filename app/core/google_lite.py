"""Minimal Firebase Auth + Firestore client built on google-auth and http.client.

firebase-admin pulls in gRPC and google-cloud-firestore (~32 MB RSS measured on
top of the app); the app only verifies ID tokens and reads/writes single
documents, which this module does over REST for ~5 MB.
"""

import base64
import datetime as _dt
import http.client
import json
import logging
import re
import threading
import time
import urllib.parse
from typing import Any, Optional

from google.auth import crypt as _crypt
from google.auth import jwt as _jwt

logger = logging.getLogger("cloud_tts_reader")

_TOKEN_CERTS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com"
_FIRESTORE_HOST = "firestore.googleapis.com"
_FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore"
_HTTP_TIMEOUT_SECONDS = 20


class GoogleApiError(Exception):
    """HTTP error from a Google API; `response` mimics botocore's shape so the
    existing not-found helpers keep working."""

    def __init__(self, status: int, body: str):
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status = status
        self.response = {"ResponseMetadata": {"HTTPStatusCode": status}, "Error": {"Code": str(status)}}


def _https(method: str, host: str, path: str, headers: Optional[dict] = None, body: Optional[bytes] = None):
    conn = http.client.HTTPSConnection(host, timeout=_HTTP_TIMEOUT_SECONDS)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        resp = conn.getresponse()
        return resp.status, dict(resp.getheaders()), resp.read()
    finally:
        conn.close()


def _request_with_retry(method, host, path, headers=None, body=None, attempts=3):
    """Retry transport errors and 429/5xx, which Google APIs document as retryable."""
    for attempt in range(attempts):
        try:
            status, resp_headers, data = _https(method, host, path, headers, body)
        except (OSError, http.client.HTTPException):
            if attempt == attempts - 1:
                raise
        else:
            if status not in (429, 500, 502, 503, 504) or attempt == attempts - 1:
                return status, resp_headers, data
        time.sleep(0.4 * (2 ** attempt))
    raise RuntimeError("unreachable")


# --------------------------------------------------------------------------
# Credentials
# --------------------------------------------------------------------------

class ServiceAccount:
    def __init__(self, info: dict):
        self.info = info
        self.project_id = info["project_id"]
        self.client_email = info["client_email"]
        self.token_uri = info.get("token_uri", "https://oauth2.googleapis.com/token")
        self._signer = _crypt.RSASigner.from_service_account_info(info)
        self._lock = threading.Lock()
        self._token: Optional[str] = None
        self._token_expiry = 0.0

    def access_token(self) -> str:
        """OAuth2 access token via the JWT-bearer grant, cached until near expiry."""
        with self._lock:
            if self._token and time.time() < self._token_expiry - 60:
                return self._token
            now = int(time.time())
            assertion = _jwt.encode(self._signer, {
                "iss": self.client_email,
                "scope": _FIRESTORE_SCOPE,
                "aud": self.token_uri,
                "iat": now,
                "exp": now + 3600,
            })
            if isinstance(assertion, bytes):
                assertion = assertion.decode("ascii")
            body = urllib.parse.urlencode({
                "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                "assertion": assertion,
            }).encode()
            parsed = urllib.parse.urlparse(self.token_uri)
            status, _, data = _request_with_retry(
                "POST", parsed.netloc, parsed.path or "/token",
                {"Content-Type": "application/x-www-form-urlencoded"}, body,
            )
            if status != 200:
                raise GoogleApiError(status, data.decode("utf-8", "replace"))
            payload = json.loads(data)
            self._token = payload["access_token"]
            self._token_expiry = time.time() + int(payload.get("expires_in", 3600))
            return self._token


def load_service_account(raw: Optional[str]) -> Optional[ServiceAccount]:
    if not raw:
        return None
    # Fly/Docker secrets often keep surrounding quotes.
    raw = raw.strip().strip("'").strip('"')
    return ServiceAccount(json.loads(raw))


# --------------------------------------------------------------------------
# Firebase ID token verification
# --------------------------------------------------------------------------

class _CertCache:
    def __init__(self):
        self._lock = threading.Lock()
        self._certs: dict = {}
        self._expiry = 0.0

    def get(self) -> dict:
        with self._lock:
            if self._certs and time.time() < self._expiry:
                return self._certs
            parsed = urllib.parse.urlparse(_TOKEN_CERTS_URL)
            status, headers, data = _request_with_retry("GET", parsed.netloc, parsed.path)
            if status != 200:
                raise GoogleApiError(status, data.decode("utf-8", "replace"))
            self._certs = json.loads(data)
            max_age = 3600
            cache_control = next((v for k, v in headers.items() if k.lower() == "cache-control"), "")
            match = re.search(r"max-age=(\d+)", cache_control)
            if match:
                max_age = int(match.group(1))
            self._expiry = time.time() + max_age
            return self._certs


_cert_cache = _CertCache()
_auth_project_id: Optional[str] = None


def configure_auth(project_id: Optional[str]) -> None:
    global _auth_project_id
    _auth_project_id = project_id


def verify_id_token(token: str, clock_skew_seconds: int = 0) -> dict:
    """Verify a Firebase ID token the way firebase_admin.auth.verify_id_token
    does (RS256 signature, aud, iss, exp/iat, sub) and add the `uid` claim."""
    if not _auth_project_id:
        raise ValueError("Firebase project is not configured")
    claims = _jwt.decode(
        token, certs=_cert_cache.get(), audience=_auth_project_id,
        clock_skew_in_seconds=clock_skew_seconds,
    )
    if claims.get("iss") != f"https://securetoken.google.com/{_auth_project_id}":
        raise ValueError("Firebase ID token has an incorrect issuer")
    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub or len(sub) > 128:
        raise ValueError("Firebase ID token has an invalid subject")
    if claims.get("auth_time", 0) > time.time() + clock_skew_seconds:
        raise ValueError("Firebase ID token auth_time is in the future")
    claims["uid"] = sub
    return claims


# --------------------------------------------------------------------------
# Firestore (REST)
# --------------------------------------------------------------------------

class _ServerTimestampSentinel:
    def __repr__(self):
        return "SERVER_TIMESTAMP"


SERVER_TIMESTAMP = _ServerTimestampSentinel()

_SIMPLE_FIELD = re.compile(r"^[A-Za-z_][A-Za-z_0-9]*$")


def _field_path(parts) -> str:
    return ".".join(
        p if _SIMPLE_FIELD.match(p) else "`" + p.replace("\\", "\\\\").replace("`", "\\`") + "`"
        for p in parts
    )


def _encode(value: Any) -> dict:
    if value is None:
        return {"nullValue": None}
    if isinstance(value, bool):
        return {"booleanValue": value}
    if isinstance(value, int):
        return {"integerValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, str):
        return {"stringValue": value}
    if isinstance(value, (bytes, bytearray)):
        return {"bytesValue": base64.b64encode(bytes(value)).decode("ascii")}
    if isinstance(value, _dt.datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=_dt.timezone.utc)
        return {"timestampValue": value.astimezone(_dt.timezone.utc).isoformat().replace("+00:00", "Z")}
    if isinstance(value, dict):
        return {"mapValue": {"fields": {str(k): _encode(v) for k, v in value.items()}}}
    if isinstance(value, (list, tuple)):
        return {"arrayValue": {"values": [_encode(v) for v in value]}}
    raise TypeError(f"Unsupported Firestore value type: {type(value).__name__}")


def _parse_timestamp(text: str) -> _dt.datetime:
    # RFC 3339 with up to nanosecond precision; Python keeps microseconds.
    match = re.match(r"^(.*?T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$", text)
    if not match:
        return _dt.datetime.fromisoformat(text)
    base, frac, tz = match.groups()
    frac = (frac or ".0")[:7].ljust(7, "0")
    tz = "+00:00" if tz == "Z" else tz
    return _dt.datetime.fromisoformat(f"{base}{frac}{tz}")


def _decode(value: dict) -> Any:
    if "nullValue" in value:
        return None
    if "booleanValue" in value:
        return value["booleanValue"]
    if "integerValue" in value:
        return int(value["integerValue"])
    if "doubleValue" in value:
        return float(value["doubleValue"])
    if "stringValue" in value:
        return value["stringValue"]
    if "timestampValue" in value:
        return _parse_timestamp(value["timestampValue"])
    if "bytesValue" in value:
        return base64.b64decode(value["bytesValue"])
    if "mapValue" in value:
        return {k: _decode(v) for k, v in value["mapValue"].get("fields", {}).items()}
    if "arrayValue" in value:
        return [_decode(v) for v in value["arrayValue"].get("values", [])]
    if "referenceValue" in value:
        return value["referenceValue"]
    if "geoPointValue" in value:
        return dict(value["geoPointValue"])
    return None


def _split_transforms(data: dict, prefix=()):
    """Separate SERVER_TIMESTAMP sentinels (sent as field transforms) from
    plain values, returning (fields, leaf_paths, transform_paths)."""
    fields, leaves, transforms = {}, [], []
    for key, value in data.items():
        path = prefix + (str(key),)
        if value is SERVER_TIMESTAMP:
            transforms.append(path)
        elif isinstance(value, dict) and value:
            sub_fields, sub_leaves, sub_transforms = _split_transforms(value, path)
            transforms.extend(sub_transforms)
            if sub_fields:
                fields[str(key)] = {"mapValue": {"fields": sub_fields}}
            leaves.extend(sub_leaves)
        else:
            fields[str(key)] = _encode(value)
            leaves.append(path)
    return fields, leaves, transforms


class DocumentSnapshot:
    def __init__(self, data: Optional[dict]):
        self.exists = data is not None
        self._data = data

    def to_dict(self) -> Optional[dict]:
        return dict(self._data) if self._data is not None else None


class DocumentReference:
    def __init__(self, client: "FirestoreClient", path: str):
        self._client = client
        self.path = path
        self.id = path.rsplit("/", 1)[-1]

    def collection(self, name: str) -> "CollectionReference":
        return CollectionReference(self._client, f"{self.path}/{name}")

    def get(self) -> DocumentSnapshot:
        status, data = self._client._call("GET", self._client._doc_url(self.path))
        if status == 404:
            return DocumentSnapshot(None)
        doc = json.loads(data)
        return DocumentSnapshot({k: _decode(v) for k, v in doc.get("fields", {}).items()})

    def set(self, document_data: dict, merge: bool = False):
        """Like google-cloud-firestore's set(): replace the document, or with
        merge=True update only the given (nested) fields."""
        fields, leaves, transforms = _split_transforms(document_data)
        write: dict = {"update": {"name": self._client._doc_name(self.path), "fields": fields}}
        if merge:
            write["updateMask"] = {"fieldPaths": [_field_path(p) for p in leaves]}
        if transforms:
            write["updateTransforms"] = [
                {"fieldPath": _field_path(p), "setToServerValue": "REQUEST_TIME"} for p in transforms
            ]
        self._client._commit([write])

    def delete(self):
        self._client._commit([{"delete": self._client._doc_name(self.path)}])


class CollectionReference:
    def __init__(self, client: "FirestoreClient", path: str):
        self._client = client
        self.path = path

    def document(self, document_id: str) -> DocumentReference:
        return DocumentReference(self._client, f"{self.path}/{document_id}")


class FirestoreClient:
    def __init__(self, account: ServiceAccount, database: str = "(default)"):
        self._account = account
        self._root = f"projects/{account.project_id}/databases/{database}/documents"

    def collection(self, name: str) -> CollectionReference:
        return CollectionReference(self, name)

    def document(self, path: str) -> DocumentReference:
        return DocumentReference(self, path)

    def _doc_name(self, path: str) -> str:
        return f"{self._root}/{path}"

    def _doc_url(self, path: str) -> str:
        return "/v1/" + urllib.parse.quote(self._doc_name(path), safe="/()")

    def _call(self, method: str, url: str, body: Optional[dict] = None):
        headers = {"Authorization": f"Bearer {self._account.access_token()}"}
        payload = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        status, _, data = _request_with_retry(method, _FIRESTORE_HOST, url, headers, payload)
        if status >= 400 and status != 404:
            raise GoogleApiError(status, data.decode("utf-8", "replace"))
        return status, data

    def _commit(self, writes: list):
        url = "/v1/" + urllib.parse.quote(self._root.rsplit("/documents", 1)[0], safe="/()") + "/documents:commit"
        status, data = self._call("POST", url, {"writes": writes})
        if status == 404:
            raise GoogleApiError(status, data.decode("utf-8", "replace"))
