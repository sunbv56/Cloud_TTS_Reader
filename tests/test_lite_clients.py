import datetime as dt
import types

import storage_adapter
from app.core import google_lite
from storage_adapter import S3LiteClient


def test_sigv4_matches_aws_documented_example(monkeypatch):
    # "Example: GET Object" from the AWS SigV4 for S3 documentation.
    fixed = dt.datetime(2013, 5, 24, 0, 0, 0, tzinfo=dt.timezone.utc)
    monkeypatch.setattr(storage_adapter, "datetime", types.SimpleNamespace(
        datetime=types.SimpleNamespace(now=lambda tz=None: fixed), timezone=dt.timezone))
    client = S3LiteClient("https://examplebucket.s3.amazonaws.com", "us-east-1",
                          "AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
    empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    headers = client._sign("GET", "/test.txt", {}, {"Range": "bytes=0-9"}, empty)
    assert headers["Authorization"] == (
        "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    )


def test_b2_region_is_derived_from_endpoint():
    client = S3LiteClient("https://s3.us-west-004.backblazeb2.com", "", "k", "s")
    assert client.region == "us-west-004"


def test_s3_not_found_error_is_recognised():
    backend = storage_adapter.B2StorageBackend()
    err = S3LiteClient("https://s3.us-west-004.backblazeb2.com", "", "k", "s")._error(404, b"")
    assert backend.is_not_found(err)


def test_firestore_value_round_trip():
    when = dt.datetime(2026, 10, 13, 5, 0, 0, 123456, tzinfo=dt.timezone.utc)
    data = {"s": "xin chào", "i": 7, "f": 1.5, "b": True, "n": None,
            "l": [1, "a"], "m": {"x": 1}, "t": when}
    encoded = {k: google_lite._encode(v) for k, v in data.items()}
    assert encoded["i"] == {"integerValue": "7"}
    assert encoded["t"] == {"timestampValue": "2026-10-13T05:00:00.123456Z"}
    decoded = {k: google_lite._decode(v) for k, v in encoded.items()}
    assert decoded == data


def test_firestore_nanosecond_timestamps_parse():
    parsed = google_lite._decode({"timestampValue": "2026-10-13T05:00:00.123456789Z"})
    assert parsed == dt.datetime(2026, 10, 13, 5, 0, 0, 123456, tzinfo=dt.timezone.utc)


def _capture_commit():
    writes = []
    client = google_lite.FirestoreClient.__new__(google_lite.FirestoreClient)
    client._root = "projects/p/databases/(default)/documents"
    client._commit = lambda w: writes.extend(w)
    return client, writes


def test_set_merge_masks_nested_leaves_and_sends_server_timestamp_as_transform():
    client, writes = _capture_commit()
    client.collection("users").document("u").collection("stories").document("s").set(
        {"title": "T", "meta": {"count": 3}, "updatedAt": google_lite.SERVER_TIMESTAMP}, merge=True)
    (write,) = writes
    assert write["update"]["name"].endswith("/documents/users/u/stories/s")
    assert sorted(write["updateMask"]["fieldPaths"]) == ["meta.count", "title"]
    assert write["updateTransforms"] == [{"fieldPath": "updatedAt", "setToServerValue": "REQUEST_TIME"}]
    assert "updatedAt" not in write["update"]["fields"]


def test_set_without_merge_replaces_document():
    client, writes = _capture_commit()
    client.document("users/u/stories/s").set({"title": "T"})
    assert "updateMask" not in writes[0]


def test_field_paths_with_special_characters_are_quoted():
    assert google_lite._field_path(("a", "b-c", "d`e")) == "a.`b-c`.`d\\`e`"
