"""
HTTP registry client — talks to a remote AgentID registry server.

Private keys never leave the machine. The server only ever sees
the public agent document.
"""

import os
import re
import time
import uuid
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
        # Security fix: sanitize DID to prevent path traversal
        # (e.g. did:agentid:../../../../tmp/evil → safe filename)
        safe = re.sub(r"[^a-zA-Z0-9_\-]", "_", did)
        path = (self.keys_dir / (safe + ".key")).resolve()
        # Ensure the resolved path stays within the keys directory
        try:
            path.relative_to(self.keys_dir.resolve())
        except ValueError:
            raise ValueError(f"Path traversal attempt blocked for DID: {did!r}")
        return path

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

    def _raise_with_context(self, response, action: str):
        """Re-raise an HTTP error with a developer-friendly message."""
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            raise RuntimeError(
                f"Registry at {self.base_url!r} returned HTTP {status} while {action}. "
                "Check that the URL is correct, the server is reachable, and "
                "AGENTID_REGISTRY_URL is set correctly (or pass registry_url= explicitly). "
                f"Raw error: {exc}"
            ) from exc

    def register(self, document, private_key_bytes: bytes):
        from agentid.crypto import sign as crypto_sign

        payload = asdict(document)

        # Fix #2 — include proof of key ownership with every registration
        proof = crypto_sign(private_key_bytes, payload)
        body = {**payload, "proof": proof}

        response = self._client.post(f"{self.base_url}/agents", json=body)
        if response.status_code == 409:
            raise ValueError(
                f"Agent already registered: {document.did}. "
                "Use Agent.load() to load the existing agent, or choose a different identity."
            )
        self._raise_with_context(response, f"registering agent {document.did!r}")
        self._save_private_key(document.did, private_key_bytes)

    def get(self, did: str) -> Optional[dict]:
        response = self._client.get(f"{self.base_url}/agents/{did}")
        if response.status_code == 404:
            return None
        self._raise_with_context(response, f"fetching agent {did!r}")
        # Fix #14 — validate content-type
        ct = response.headers.get("content-type", "")
        if "application/json" not in ct:
            raise ValueError(
                f"Registry at {self.base_url!r} returned unexpected content-type {ct!r} "
                f"while fetching agent {did!r}. Expected 'application/json'. "
                "Check that the registry URL points to an AgentID-compatible server."
            )
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
        self._raise_with_context(response, "searching agents")
        return response.json()

    def deregister(self, did: str, private_key_bytes: bytes):
        from agentid.crypto import sign as crypto_sign

        # Fix #1 — prove ownership with a signature instead of plain owner string
        # MED-2: include nonce so server can reject replays within the 300s window
        payload = {
            "action": "deregister",
            "did": did,
            "timestamp": time.time(),
            "nonce": str(uuid.uuid4()),
        }
        signature = crypto_sign(private_key_bytes, payload)
        response = self._client.request(
            "DELETE",
            f"{self.base_url}/agents/{did}",
            json={"payload": payload, "signature": signature},
        )
        self._raise_with_context(response, f"deregistering agent {did!r}")

    def verify_signature(self, did: str, payload: dict, signature: str,
                         verifier_did: str = None) -> bool:
        body = {"payload": payload, "signature": signature}
        if verifier_did:
            body["verifier_did"] = verifier_did
        response = self._client.post(
            f"{self.base_url}/agents/{did}/verify",
            json=body,
        )
        if response.status_code == 404:
            return False
        self._raise_with_context(response, f"verifying signature for {did!r}")
        return response.json()["valid"]

    def publish_capability_contract(self, did: str, contract: dict) -> dict:
        """
        POST a signed Capability Contract to the registry.

        Args:
            did:      The agent DID (must be owned by the API key used).
            contract: Contract dict with capability, version, input_schema,
                      output_schema, sla, pricing, remedies, signature, signed_at.

        Returns:
            The server response dict with the registered contract.

        Raises:
            RuntimeError on 4xx/5xx responses (with actionable message).
        """
        response = self._client.post(
            f"{self.base_url}/agents/{did}/capability-contracts",
            json=contract,
        )
        self._raise_with_context(response, f"publishing capability contract for {did!r}")
        return response.json()

    def get_capability_contracts(self, did: str) -> list[dict]:
        """Fetch all active Capability Contracts for a DID (public)."""
        response = self._client.get(f"{self.base_url}/agents/{did}/capability-contracts")
        self._raise_with_context(response, f"fetching capability contracts for {did!r}")
        return response.json().get("contracts", [])

    def ping(self) -> bool:
        try:
            response = self._client.get(f"{self.base_url}/health")
            return response.status_code == 200
        except httpx.RequestError:
            return False
