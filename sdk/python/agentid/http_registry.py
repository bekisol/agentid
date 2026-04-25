"""
HTTP registry client — talks to a remote AgentID registry server.

Private keys never leave the machine. The server only ever sees
the public agent document.
"""

import os
import time
from dataclasses import asdict
from pathlib import Path
from typing import Optional

import httpx

DEFAULT_KEYS_DIR = Path.home() / ".agentid" / "keys"


class HTTPRegistry:
    def __init__(self, url: str, keys_dir: str = None):
        # Fix #7 — enforce HTTPS for all remote registries
        if not url.startswith("https://") and not url.startswith("http://localhost") and not url.startswith("http://127.0.0.1"):
            raise ValueError("Registry URL must use HTTPS (or localhost for dev)")
        self.base_url = url.rstrip("/")
        self.keys_dir = Path(keys_dir) if keys_dir else DEFAULT_KEYS_DIR
        self.keys_dir.mkdir(parents=True, exist_ok=True)
        self._client = httpx.Client(verify=True, timeout=10)

    # ── private key storage (always local, never sent to server) ─────────────

    def _key_path(self, did: str) -> Path:
        return self.keys_dir / (did.replace(":", "_") + ".key")

    def _save_private_key(self, did: str, private_key_bytes: bytes):
        key_file = self._key_path(did)
        # Fix #6 — create file with restrictive permissions atomically
        fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, private_key_bytes)
        finally:
            os.close(fd)

    def load_private_key(self, did: str) -> Optional[bytes]:
        key_file = self._key_path(did)
        return key_file.read_bytes() if key_file.exists() else None

    # ── remote operations ─────────────────────────────────────────────────────

    def register(self, document, private_key_bytes: bytes):
        from agentid.crypto import sign as crypto_sign

        payload = asdict(document)

        # Fix #2 — include proof of key ownership with every registration
        proof = crypto_sign(private_key_bytes, payload)
        body = {**payload, "proof": proof}

        response = self._client.post(f"{self.base_url}/agents", json=body)
        if response.status_code == 409:
            raise ValueError(f"Agent already registered: {document.did}")
        response.raise_for_status()
        self._save_private_key(document.did, private_key_bytes)

    def get(self, did: str) -> Optional[dict]:
        response = self._client.get(f"{self.base_url}/agents/{did}")
        if response.status_code == 404:
            return None
        response.raise_for_status()
        # Fix #14 — validate content-type
        ct = response.headers.get("content-type", "")
        if "application/json" not in ct:
            raise ValueError(f"Unexpected content-type from registry: {ct}")
        return response.json()

    def search(self, capability: str = None, owner: str = None, name: str = None) -> list[dict]:
        params = {}
        if capability:
            params["capability"] = capability
        if owner:
            params["owner"] = owner
        if name:
            params["name"] = name
        response = self._client.get(f"{self.base_url}/agents", params=params)
        response.raise_for_status()
        return response.json()

    def deregister(self, did: str, private_key_bytes: bytes):
        from agentid.crypto import sign as crypto_sign

        # Fix #1 — prove ownership with a signature instead of plain owner string
        payload = {
            "action": "deregister",
            "did": did,
            "timestamp": time.time(),
        }
        signature = crypto_sign(private_key_bytes, payload)
        response = self._client.request(
            "DELETE",
            f"{self.base_url}/agents/{did}",
            json={"payload": payload, "signature": signature},
        )
        response.raise_for_status()

    def verify_signature(self, did: str, payload: dict, signature: str) -> bool:
        response = self._client.post(
            f"{self.base_url}/agents/{did}/verify",
            json={"payload": payload, "signature": signature},
        )
        if response.status_code == 404:
            return False
        response.raise_for_status()
        return response.json()["valid"]

    def ping(self) -> bool:
        try:
            response = self._client.get(f"{self.base_url}/health")
            return response.status_code == 200
        except httpx.RequestError:
            return False
