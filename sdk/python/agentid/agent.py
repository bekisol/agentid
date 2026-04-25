import time
import uuid
from datetime import datetime, timezone
from dataclasses import dataclass, field

from .crypto import sign as crypto_sign, verify as crypto_verify
from .identity import (
    generate_keypair, public_key_to_did,
    public_key_to_b64, b64_to_public_key_bytes,
)
from .registry import Registry
from .http_registry import HTTPRegistry


@dataclass
class AgentDocument:
    did: str
    name: str
    capabilities: list[str]
    owner: str
    public_key: str          # base64-encoded ed25519 public key
    created_at: str
    metadata: dict = field(default_factory=dict)


def _registry(registry_path: str = None, registry_url: str = None):
    """Return the right registry implementation based on what the caller provided."""
    if registry_url:
        return HTTPRegistry(registry_url)
    return Registry(registry_path)


class Agent:
    def __init__(self, document: AgentDocument, private_key_bytes: bytes = None):
        self.document = document
        self._private_key = private_key_bytes

    # ── properties ───────────────────────────────────────────────────────────

    @property
    def did(self) -> str:
        return self.document.did

    @property
    def name(self) -> str:
        return self.document.name

    @property
    def capabilities(self) -> list[str]:
        return self.document.capabilities

    # ── factory methods ──────────────────────────────────────────────────────

    @classmethod
    def create(
        cls,
        name: str,
        capabilities: list[str],
        owner: str,
        metadata: dict = None,
        registry_path: str = None,
        registry_url: str = None,
    ) -> "Agent":
        private_bytes, public_bytes = generate_keypair()
        did = public_key_to_did(public_bytes)

        document = AgentDocument(
            did=did,
            name=name,
            capabilities=capabilities,
            owner=owner,
            public_key=public_key_to_b64(public_bytes),
            created_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            metadata=metadata or {},
        )

        _registry(registry_path, registry_url).register(document, private_bytes)
        return cls(document, private_bytes)

    @classmethod
    def load(
        cls,
        did: str,
        registry_path: str = None,
        registry_url: str = None,
    ) -> "Agent":
        reg = _registry(registry_path, registry_url)
        data = reg.get(did)
        if data is None:
            raise KeyError(f"Agent not found: {did}")
        document = AgentDocument(**data)
        private_key_bytes = reg.load_private_key(did)
        return cls(document, private_key_bytes)

    # ── discovery ─────────────────────────────────────────────────────────────

    @staticmethod
    def resolve(
        did: str,
        registry_path: str = None,
        registry_url: str = None,
    ) -> "AgentDocument | None":
        data = _registry(registry_path, registry_url).get(did)
        return AgentDocument(**data) if data else None

    @staticmethod
    def find(
        capability: str = None,
        owner: str = None,
        registry_path: str = None,
        registry_url: str = None,
    ) -> list["AgentDocument"]:
        results = _registry(registry_path, registry_url).search(
            capability=capability, owner=owner
        )
        return [AgentDocument(**d) for d in results]

    # ── signing ───────────────────────────────────────────────────────────────

    def sign(self, payload: dict) -> dict:
        if self._private_key is None:
            raise RuntimeError("No private key — agent was loaded read-only")

        signed_payload = {
            **payload,
            "signer": self.did,
            "timestamp": time.time(),
            "nonce": str(uuid.uuid4()),
        }
        return {
            "payload": signed_payload,
            "signature": crypto_sign(self._private_key, signed_payload),
        }

    def verify_message(self, signed_message: dict) -> bool:
        public_key_bytes = b64_to_public_key_bytes(self.document.public_key)
        return crypto_verify(
            public_key_bytes,
            signed_message["payload"],
            signed_message["signature"],
        )

    @staticmethod
    def verify_from_did(
        signed_message: dict,
        registry_path: str = None,
        registry_url: str = None,
    ) -> bool:
        did = signed_message["payload"].get("signer")
        if not did:
            return False
        data = _registry(registry_path, registry_url).get(did)
        if not data:
            return False
        public_key_bytes = b64_to_public_key_bytes(data["public_key"])
        return crypto_verify(
            public_key_bytes,
            signed_message["payload"],
            signed_message["signature"],
        )

    # ── repr ──────────────────────────────────────────────────────────────────

    def __repr__(self) -> str:
        return f"Agent(name={self.name!r}, did={self.did[:30]}..., capabilities={self.capabilities})"
