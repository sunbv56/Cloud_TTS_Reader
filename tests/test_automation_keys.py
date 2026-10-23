from types import SimpleNamespace

from app.core import security


def _req(headers):
    return SimpleNamespace(headers={k.lower(): v for k, v in headers.items()})


def test_parse_automation_keys():
    assert security._parse_automation_keys(" k1:u1, k2:u2 ,bad,:x,y:") == {"k1": "u1", "k2": "u2"}


def test_api_key_auth(monkeypatch):
    monkeypatch.setattr(security, "_AUTOMATION_KEYS", {"k1": "u1"})
    monkeypatch.setattr(security, "firebase_admin_initialized", True)
    assert security._authorization_error(_req({"X-API-Key": "k1"}), "u1") is None
    assert security._authorization_error(_req({"X-API-Key": "k1"}), "u2").status_code == 403
    assert security._authorization_error(_req({"X-API-Key": "nope"}), "u1").status_code == 401
    assert security._authorization_error(_req({}), "u1").status_code == 401
