"""Small storage compatibility layer for Firebase Storage and Backblaze B2.

The application historically used the Firebase Admin ``bucket/blob`` API.  This
module intentionally preserves that interface so the book/segment code can be
migrated without changing its storage paths or Firestore metadata.
"""

import os
from typing import Optional


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
        response = self._backend.client.get_object(
            Bucket=self._backend.bucket_name,
            Key=self.path,
        )
        return response["Body"].read().decode("utf-8")

    def download_as_bytes(self):
        response = self._backend.client.get_object(
            Bucket=self._backend.bucket_name,
            Key=self.path,
        )
        return response["Body"].read()

    def download_to_filename(self, filename):
        self._backend.client.download_file(
            self._backend.bucket_name,
            self.path,
            filename,
        )

    def delete(self):
        return self._backend.client.delete_object(
            Bucket=self._backend.bucket_name,
            Key=self.path,
        )


class B2StorageBackend:
    def __init__(self):
        try:
            import boto3
            from botocore.exceptions import ClientError
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
        self.client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            region_name=region,
            aws_access_key_id=key_id,
            aws_secret_access_key=application_key,
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
