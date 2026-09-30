"""Parspec PM events: subscribe, verify, callback. Requires `cryptography`; HTTP is stdlib."""

import base64
import binascii
import json
import re
import urllib.error
import urllib.request

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

ENVIRONMENTS = {
    "production": "https://platform.parspec.io/platform-api/api/v1/",
    "sandbox": "https://platform-sandbox.parspec.io/platform-api/api/v1/",
    "preprod": "https://uat-platform.parspec.io/platform-api/api/v1/",
}
DEFAULT_CALLBACK = "integrations/events/callback"


class SignatureError(Exception):
    pass


class ParspecApiError(Exception):
    def __init__(self, message, status, body=None):
        super().__init__(message)
        self.status = status
        self.body = body


def verify(raw_body: bytes, signature: str, public_key_pem: str) -> bool:
    """True when X-Signature (base64 RSA-SHA256) verifies against the RAW request bytes.
    Re-serialized JSON will not verify; pass the body exactly as received."""
    if not signature:
        return False
    try:
        key = serialization.load_pem_public_key(public_key_pem.encode())
        key.verify(base64.b64decode(signature, validate=True), raw_body, padding.PKCS1v15(), hashes.SHA256())
        return True
    except (InvalidSignature, binascii.Error, ValueError):
        return False


def _header(headers, name):
    return next((v for k, v in (headers or {}).items() if k.lower() == name.lower()), None)


def parse_event(raw_body: bytes, headers, public_key_pem: str) -> dict:
    """Verify then parse. Raises SignatureError on a bad or missing signature.
    Deduplicate on transaction_id: PM can deliver the same event more than once."""
    if not verify(raw_body, _header(headers, "x-signature"), public_key_pem):
        raise SignatureError("X-Signature did not verify")
    event = json.loads(raw_body)
    return {
        "event": event,
        "transaction_id": event.get("eventTransactionID"),
        "idempotency_key": _header(headers, "idempotency-key"),
    }


def _urllib_send(method, url, headers, body):
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, res.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


class Client:
    def __init__(self, api_key, environment="production", base_url=None, send=_urllib_send):
        if not api_key:
            raise ValueError("api_key is required")
        base = base_url or ENVIRONMENTS.get(environment)
        if not base:
            raise ValueError(f"unknown environment: {environment}")
        self._base = base if base.endswith("/") else base + "/"
        self._api_key = api_key
        self._send = send

    def _call(self, method, path_or_url, body):
        url = path_or_url if re.match(r"https?://", path_or_url) else self._base + path_or_url.lstrip("/")
        headers = {"x-api-key": self._api_key, "Content-Type": "application/json"}
        status, text = self._send(method, url, headers, json.dumps(body).encode())
        try:
            parsed = json.loads(text) if text else None
        except ValueError:
            parsed = None
        return status, parsed, text or ""

    def unsubscribe(self, event_type, version=None):
        """Omit version to clear both 1 and 2 (only one can be active)."""
        out = []
        for v in [version] if version else [1, 2]:
            status, _, _ = self._call("DELETE", "integrations/events/unsubscribe", {"event_type": event_type, "event_version": v})
            out.append({"version": v, "status": status})
        return out

    def subscribe(self, event_type, version, webhook_url):
        """Subscribe is not an upsert, so both versions are cleared first. Returns the NEW public key:
        every subscribe mints one and events are signed with it from now on."""
        self.unsubscribe(event_type)
        body = {"event_type": event_type, "event_version": version, "webhook_url": webhook_url}
        status, parsed, text = self._call("PUT", "integrations/events/subscribe", body)
        # An org can hold more than one subscription for the same event; each DELETE removes one.
        replaced = 0
        while status == 400 and re.search(r"already exists", text, re.I) and replaced < 3:
            named = re.search(r"version\s+'?(\d+)'?", text, re.I)
            v = int(named.group(1)) if named else version
            del_status, _, _ = self._call("DELETE", "integrations/events/unsubscribe", {"event_type": event_type, "event_version": v})
            if del_status != 200:
                break
            replaced += 1
            status, parsed, text = self._call("PUT", "integrations/events/subscribe", body)
        if status != 200 or not parsed or not parsed.get("publicKey"):
            raise ParspecApiError(f"subscribe {event_type} v{version} failed: {status} {text[:200]}", status, parsed)
        return {"publicKey": parsed["publicKey"], "replaced": replaced}

    def _send_callback(self, event, status, fields):
        body = {"EventTransactionID": event.get("eventTransactionID"), "EventStatus": status, **fields}
        code, parsed, text = self._call("POST", event.get("callback_url") or DEFAULT_CALLBACK, body)
        if not 200 <= code < 300:
            raise ParspecApiError(f"callback failed: {code} {text[:200]}", code, parsed)
        return parsed

    def callback(self, event, fields=None):
        """One callback per event. `fields` carries what PM expects back (orderId, projectErpId, ...)."""
        return self._send_callback(event, "success", fields or {})

    def fail(self, event, message, fields=None):
        """The message is shown to the PM user (e.g. a failed credit check)."""
        return self._send_callback(event, "error", {"errorMessage": message, **(fields or {})})
