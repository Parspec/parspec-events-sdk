"""Parspec PM events: subscribe, verify, callback. Requires `cryptography`; HTTP is stdlib."""

from __future__ import annotations

import base64
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Mapping, Optional, Tuple

from cryptography.exceptions import InvalidSignature, UnsupportedAlgorithm
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

ENVIRONMENTS = {
    "production": "https://platform.parspec.io/platform-api/api/v1/",
    "sandbox": "https://platform-sandbox.parspec.io/platform-api/api/v1/",
    "preprod": "https://uat-platform.parspec.io/platform-api/api/v1/",
}
DEFAULT_CALLBACK = "integrations/events/callback"

# send(method, url, headers, body) -> (status, text); raise OSError for network failures.
Send = Callable[[str, str, Mapping[str, str], bytes], Tuple[int, str]]


class SignatureError(Exception):
    """The signature did not verify: the request did not come from PM, or the key is stale."""


class EventError(ValueError):
    """The signature verified, but the body is not a PM event envelope."""


class ParspecApiError(Exception):
    """A PM API call failed. status is the HTTP status, or 0 when there was no response
    (network failure, timeout) or the request was refused before sending."""

    def __init__(self, message: str, status: int, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body

    def __reduce__(self) -> Any:  # picklable (multiprocessing, task queues)
        return (self.__class__, (self.args[0], self.status, self.body))


def verify(raw_body: bytes, signature: Optional[str], public_key_pem: Optional[str]) -> bool:
    """True when X-Signature (base64 RSA-SHA256) verifies against the RAW request bytes, False otherwise.

    Never raises: a bad signature, a bad key and a non-RSA key all return False.
    Re-serialized JSON will not verify; pass the body exactly as received.
    """
    if not signature or not isinstance(signature, str) or not isinstance(public_key_pem, (str, bytes)):
        return False
    pem = public_key_pem.encode() if isinstance(public_key_pem, str) else public_key_pem
    try:
        key = serialization.load_pem_public_key(pem)
        if not isinstance(key, rsa.RSAPublicKey):
            return False
        key.verify(base64.b64decode(signature, validate=True), bytes(raw_body), padding.PKCS1v15(), hashes.SHA256())
        return True
    except (InvalidSignature, ValueError, TypeError, UnsupportedAlgorithm):  # binascii.Error is a ValueError
        return False


def _header(headers: Optional[Mapping[str, str]], name: str) -> Optional[str]:
    return next((v for k, v in (headers or {}).items() if k.lower() == name.lower()), None)


def parse_event(raw_body: bytes, headers: Optional[Mapping[str, str]], public_key_pem: str) -> dict:
    """Verify then parse.

    Raises SignatureError on a bad or missing signature, EventError when a signed body is not a
    PM event. Deduplicate on transaction_id: PM can deliver the same event more than once.
    """
    if not verify(raw_body, _header(headers, "x-signature"), public_key_pem):
        raise SignatureError("X-Signature did not verify")
    try:
        event = json.loads(raw_body)
    except ValueError as e:
        raise EventError(f"body is not JSON: {e}") from e
    if not isinstance(event, dict) or not isinstance(event.get("eventTransactionID"), str) or not event["eventTransactionID"]:
        raise EventError("body is not a PM event: expected an object with an eventTransactionID")
    return {
        "event": event,
        "transaction_id": event["eventTransactionID"],
        "idempotency_key": _header(headers, "idempotency-key"),
    }


def _urllib_sender(timeout: float) -> Send:
    def send(method: str, url: str, headers: Mapping[str, str], body: bytes) -> Tuple[int, str]:
        req = urllib.request.Request(url, data=body, headers=dict(headers), method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 - URL is checked by Client._resolve
                return res.status, res.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace")

    return send


class Client:
    """PM events API client: subscribe, unsubscribe, and callbacks."""

    def __init__(self, api_key: str, environment: str = "production", base_url: Optional[str] = None,
                 send: Optional[Send] = None, timeout: float = 30) -> None:
        if not api_key:
            raise ValueError("api_key is required")
        base = base_url or ENVIRONMENTS.get(environment)
        if not base:
            raise ValueError(f"unknown environment: {environment}")
        self._base = base if base.endswith("/") else base + "/"
        self._origin = urllib.parse.urlsplit(self._base)[:2]
        self._api_key = api_key
        self._send = send or _urllib_sender(timeout)

    def _resolve(self, path_or_url: str) -> str:
        # An absolute URL is allowed only on the base's origin: the API key goes with every request,
        # so a host named in a payload must never receive it.
        if not re.match(r"https?://", path_or_url, re.I):
            return self._base + path_or_url.lstrip("/")
        parts = urllib.parse.urlsplit(path_or_url)
        if (parts.scheme.lower(), parts.netloc.lower()) != (self._origin[0].lower(), self._origin[1].lower()):
            raise ParspecApiError(f"refusing to send the API key to {parts.scheme}://{parts.netloc}", 0)
        return path_or_url

    def _call(self, method: str, path_or_url: str, body: Any) -> Tuple[int, Any, str]:
        url = self._resolve(path_or_url)
        headers = {"x-api-key": self._api_key, "Content-Type": "application/json"}
        try:
            status, text = self._send(method, url, headers, json.dumps(body).encode())
        except OSError as e:  # URLError, timeouts, connection errors
            raise ParspecApiError(f"{method} {url} failed: {e}", 0) from e
        try:
            parsed = json.loads(text) if text else None
        except ValueError:
            parsed = None  # non-JSON body: the text is kept
        return status, parsed, text or ""

    def unsubscribe(self, event_type: str, version: Optional[int] = None) -> list:
        """Omit version to clear both 1 and 2 (only one can be active)."""
        out = []
        for v in [version] if version is not None else [1, 2]:
            status, _, _ = self._call("DELETE", "integrations/events/unsubscribe", {"event_type": event_type, "event_version": v})
            out.append({"version": v, "status": status})
        return out

    def subscribe(self, event_type: str, version: int, webhook_url: str) -> dict:
        """Subscribe (both versions are cleared first: subscribe is not an upsert).

        Returns the NEW public key: every subscribe mints one and events are signed with it from now on.
        """
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
        key = parsed.get("publicKey") if isinstance(parsed, dict) else None
        if status != 200 or not isinstance(key, str) or not key:
            raise ParspecApiError(f"subscribe {event_type} v{version} failed: {status} {text[:200]}", status, parsed)
        return {"publicKey": key, "replaced": replaced}

    def _send_callback(self, event: Mapping[str, Any], status: str, fields: Mapping[str, Any]) -> Any:
        # The SDK's two fields last, so a caller's fields cannot forge them.
        body = {**fields, "EventTransactionID": event.get("eventTransactionID"), "EventStatus": status}
        code, parsed, text = self._call("POST", event.get("callback_url") or DEFAULT_CALLBACK, body)
        if not 200 <= code < 300:
            raise ParspecApiError(f"callback failed: {code} {text[:200]}", code, parsed)
        return parsed

    def callback(self, event: Mapping[str, Any], fields: Optional[Mapping[str, Any]] = None) -> Any:
        """One callback per event. `fields` carries what PM expects back (orderId, projectErpId, ...)."""
        return self._send_callback(event, "success", fields or {})

    def fail(self, event: Mapping[str, Any], message: str, fields: Optional[Mapping[str, Any]] = None) -> Any:
        """Send an error callback. The message is shown to the PM user (e.g. a failed credit check)."""
        return self._send_callback(event, "error", {**(fields or {}), "errorMessage": message})
