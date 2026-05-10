import re
import secrets
import time
import uuid
from datetime import datetime, timezone
from dataclasses import dataclass, field

_DID_RE = re.compile(r'^did:agentid:[1-9A-HJ-NP-Za-km-z]{32,64}$')

from .crypto import sign as crypto_sign, verify as crypto_verify
from .identity import (
    generate_keypair, public_key_to_did,
    public_key_to_b64, public_key_to_multibase, b64_to_public_key_bytes,
)
from .registry import Registry
from .http_registry import HTTPRegistry


@dataclass
class AgentDocument:
    did: str
    name: str
    capabilities: list[str]
    owner: str
    public_key: str          # base64-encoded ed25519 public key (primary / backward-compat)
    created_at: str
    metadata: dict = field(default_factory=dict)
    verification_methods: list[dict] = field(default_factory=list)
    # verification_methods format (W3C DID Core):
    # [{"id": "did:agentid:xxx#key-1",
    #   "type": "Ed25519VerificationKey2020",
    #   "controller": "did:agentid:xxx",
    #   "publicKeyMultibase": "z<base58-encoded-key>"}]


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
        pub_b64 = public_key_to_b64(public_bytes)

        # W3C DID Core verificationMethod array — supports key rotation without DID change.
        # publicKeyMultibase MUST be multibase base58btc: "z" + base58btc(0xED01 + raw_key_bytes).
        # Using bare base64 here is incorrect and will fail external DID resolvers.
        verification_methods = [{
            "id":                 f"{did}#key-1",
            "type":               "Ed25519VerificationKey2020",
            "controller":         did,
            "publicKeyMultibase": public_key_to_multibase(public_bytes),
        }]

        document = AgentDocument(
            did=did,
            name=name,
            capabilities=capabilities,
            owner=owner,
            public_key=pub_b64,
            created_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            metadata=metadata or {},
            verification_methods=verification_methods,
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
            raise KeyError(
                f"Agent not found: {did}. "
                "Check that the DID is correct and that this registry contains it. "
                "If using a remote registry, verify AGENTID_REGISTRY_URL or pass registry_url= explicitly."
            )
        # AgentDocument may not have verification_methods in older registry data — default to []
        if "verification_methods" not in data:
            data["verification_methods"] = []

        # Re-derive publicKeyMultibase from the authoritative public_key field.
        # Older records stored bare base64 here instead of multibase (z-prefixed base58btc).
        # Correct on read so that any consumer gets a valid DID document regardless of
        # when the agent was created.
        if data["verification_methods"] and data.get("public_key"):
            from .identity import public_key_to_multibase, b64_to_public_key_bytes as _b64b
            try:
                correct_multibase = public_key_to_multibase(_b64b(data["public_key"]))
                for vm in data["verification_methods"]:
                    if vm.get("publicKeyMultibase", "").startswith("z"):
                        pass  # already correct multibase
                    else:
                        vm["publicKeyMultibase"] = correct_multibase
            except Exception:
                pass  # non-fatal — best effort migration

        document = AgentDocument(**data)

        # Fix #9 — verify DID is cryptographically bound to the stored public key
        from .identity import b64_to_public_key_bytes, public_key_to_did
        expected_did = public_key_to_did(b64_to_public_key_bytes(document.public_key))
        if document.did != expected_did:
            raise ValueError(
                f"DID mismatch: registry says {document.did!r} but the stored public key "
                f"derives {expected_did!r}. The key file may be for a different agent, or "
                "the registry record has been tampered with."
            )

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
        name: str = None,
        registry_path: str = None,
        registry_url: str = None,
    ) -> list["AgentDocument"]:
        results = _registry(registry_path, registry_url).search(
            capability=capability, owner=owner, name=name
        )
        return [AgentDocument(**d) for d in results]

    # ── signing ───────────────────────────────────────────────────────────────

    def sign(self, payload: dict) -> dict:
        if self._private_key is None:
            raise RuntimeError(
                "This agent has no private key. "
                "Load with Agent.load(did, key_path=...) to load an existing agent, "
                "or use Agent.create() to generate a new agent with a fresh key."
            )

        signed_payload = {
            **payload,
            "signer": self.did,
            "timestamp": int(time.time()),   # Unix seconds — matches TypeScript/Go
            "nonce": str(uuid.uuid4()),
        }
        return {
            "payload":   signed_payload,
            "signature": crypto_sign(self._private_key, signed_payload),  # envelope dict
        }

    def verify_message(self, signed_message: dict, max_age_seconds: int = 300) -> bool:
        # Fix #8 — reject replayed signatures older than max_age_seconds
        timestamp = signed_message.get("payload", {}).get("timestamp")
        if timestamp is None:
            return False  # require timestamp — unsigned messages are not replayed
        try:
            if (time.time() - float(timestamp)) > max_age_seconds:
                return False
        except (TypeError, ValueError):
            return False
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
        max_age_seconds: int = 300,
        verifier_did: str = None,
    ) -> bool:
        """
        Verify a signed message by resolving the signer's DID from the registry.

        verifier_did — optionally pass the DID of the agent performing this
        verification.  When using an HTTP registry this is recorded server-side,
        making the agent-to-agent trust relationship visible in the dashboard.
        """
        did = signed_message["payload"].get("signer")
        if not did:
            return False
        if not _DID_RE.match(did):
            return False
        # Fix #8 — reject replayed signatures
        timestamp = signed_message["payload"].get("timestamp")
        if timestamp is None:
            return False
        try:
            if (time.time() - float(timestamp)) > max_age_seconds:
                return False
        except (TypeError, ValueError):
            return False

        reg = _registry(registry_path, registry_url)

        # When using an HTTP registry, delegate to the server's verify endpoint.
        # This logs the event (with verifier_did) so it appears in the dashboard.
        if isinstance(reg, HTTPRegistry):
            return reg.verify_signature(
                did,
                signed_message["payload"],
                signed_message["signature"],
                verifier_did=verifier_did,
            )

        # Local registry — verify cryptographically without a network call.
        data = reg.get(did)
        if not data:
            return False
        public_key_bytes = b64_to_public_key_bytes(data["public_key"])
        return crypto_verify(
            public_key_bytes,
            signed_message["payload"],
            signed_message["signature"],
        )

    # ── capability contracts ──────────────────────────────────────────────────

    def sign_capability_contract(
        self,
        capability: str,
        version: str = "1.0",
        description: str = "",
        input_schema: dict = None,
        output_schema: dict = None,
        sla: dict = None,
        pricing: dict = None,
        remedies: dict = None,
    ) -> dict:
        """
        Build and cryptographically sign a Capability Contract.

        The signature covers the canonical contract body (JSON, sorted keys,
        no spaces) using this agent's Ed25519 private key.

        Returns a dict ready to pass to ``publish_capability_contract()``.

        Example::

            contract = agent.sign_capability_contract(
                capability="web-search",
                description="Search the web and return structured results.",
                input_schema={"type": "string", "description": "search query"},
                output_schema={"type": "array", "items": {"type": "object"}},
                sla={"max_latency_seconds": 5, "availability_target": 0.99},
                pricing={"model": "per_call", "price_usd": 0.001},
                remedies={"on_sla_breach": "refund"},
            )

        """
        if self._private_key is None:
            raise RuntimeError(
                "This agent has no private key. "
                "Load with Agent.load(did, key_path=...) to load an existing agent, "
                "or use Agent.create() to generate a new agent with a fresh key."
            )

        issued_at = int(time.time())
        body = {
            "did": self.did,
            "capability": capability,
            "version": version,
            "description": description or "",
            "input_schema": input_schema or {},
            "output_schema": output_schema or {},
            "sla": sla or {},
            "pricing": pricing or {"model": "free"},
            "remedies": remedies or {},
            "nonce": secrets.token_hex(16),    # replay protection (v0.6+)
            "issued_at": issued_at,            # staleness check on server
        }

        # Sign the canonical body (sort_keys, no spaces — matches server verification
        # in capability_contracts._verify_contract_signature)
        signature = crypto_sign(self._private_key, body)

        return {
            **body,
            "signature": signature,
            "signed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }

    def publish_capability_contract(
        self,
        capability: str,
        version: str = "1.0",
        description: str = "",
        input_schema: dict = None,
        output_schema: dict = None,
        sla: dict = None,
        pricing: dict = None,
        remedies: dict = None,
        registry_url: str = None,
        registry_path: str = None,
    ) -> dict:
        """
        Sign and publish a Capability Contract to the registry.

        Requires an HTTP registry (``registry_url``). The contract is signed
        with this agent's private key before being sent.

        Returns the server response dict with the registered contract.

        Example::

            result = agent.publish_capability_contract(
                capability="web-search",
                sla={"max_latency_seconds": 5, "availability_target": 0.99},
                pricing={"model": "per_call", "price_usd": 0.001},
                registry_url="https://api.agentid-protocol.com",
            )
            print(result["contract"]["id"])

        """
        contract = self.sign_capability_contract(
            capability=capability,
            version=version,
            description=description,
            input_schema=input_schema,
            output_schema=output_schema,
            sla=sla,
            pricing=pricing,
            remedies=remedies,
        )

        reg = _registry(registry_path, registry_url)
        if not isinstance(reg, HTTPRegistry):
            raise RuntimeError(
                "publish_capability_contract() requires an HTTP registry. "
                "Pass registry_url='https://api.agentid-protocol.com'"
            )
        return reg.publish_capability_contract(self.did, contract)

    # ── repr ──────────────────────────────────────────────────────────────────

    def __repr__(self) -> str:
        return f"Agent(name={self.name!r}, did={self.did[:30]}..., capabilities={self.capabilities})"
