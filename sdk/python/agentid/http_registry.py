"""
HTTP registry client — talks to a remote AgentID registry server.

Private keys never leave the machine. The server only ever sees
the public agent document.
"""

import os
from dataclasses import asdict
from pathlib import Path
from typing import Optional

import httpx

DEFAULT_KEYS_DIR = Path.home() / ".agentid" / "keys"


class HTTPRegistry:
    def __init__(self, url: str, keys_dir: str = None):
        self.base_url = url.rstrip("/")
        self.keys_dir = Path(keys_dir) if keys_dir else DEFAULT_KEYS_DIR
        self.keys_dir.mkdir(parents=True, exist_ok=True)

    # ── private key storage (always local, never sent to server) ─────────────

    def _key_path(self, did: str) -> Path:
        return self.keys_dir / (did.replace(":", "_") + ".key")

    def _save_private_key(self, did: str, private_key_bytes: bytes):
        key_file = self._key_path(did)
        key_file.write_bytes(private_key_bytes)
        os.chmod(key_file, 0o600)

    def load_private_key(self, did: str) -> Optional[bytes]:
        key_file = self._key_path(did)
        return key_file.read_bytes() if key_file.exists() else None

    # ── remote operations ─────────────────────────────────────────────────────

    def register(self, document, private_key_bytes: bytes):
        response = httpx.post(
            f"{self.base_url}/agents",
            json=asdict(document),
            timeout=10,
        )
        if response.status_code == 409:
            raise ValueError(f"Agent already registered: {document.did}")
        response.raise_for_status()
        self._save_private_key(document.did, private_key_bytes)

    def get(self, did: str) -> Optional[dict]:
        response = httpx.get(f"{self.base_url}/agents/{did}", timeout=10)
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.json()

    def search(self, capability: str = None, owner: str = None, name: str = None) -> list[dict]:
        params = {}
        if capability:
            params["capability"] = capability
        if owner:
            params["owner"] = owner
        if name:
            params["name"] = name
        response = httpx.get(f"{self.base_url}/agents", params=params, timeout=10)
        response.raise_for_status()
        return response.json()

    def deregister(self, did: str, owner: str):
        response = httpx.delete(
            f"{self.base_url}/agents/{did}",
            params={"owner": owner},
            timeout=10,
        )
        response.raise_for_status()

    def verify_signature(self, did: str, payload: dict, signature: str) -> bool:
        response = httpx.post(
            f"{self.base_url}/agents/{did}/verify",
            json={"payload": payload, "signature": signature},
            timeout=10,
        )
        if response.status_code == 404:
            return False
        response.raise_for_status()
        return response.json()["valid"]

    def ping(self) -> bool:
        try:
            response = httpx.get(f"{self.base_url}/health", timeout=5)
            return response.status_code == 200
        except httpx.RequestError:
            return False
