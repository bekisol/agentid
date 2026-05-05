"""AgentID query engine wrapper for LlamaIndex.

Wraps any LlamaIndex query engine and signs every response with the
agent's Ed25519 private key. Downstream agents can verify the signature
using only the signer's DID — no shared secret required.

Usage::

    from llama_index.core import VectorStoreIndex, SimpleDirectoryReader
    from llamaindex_agentid import AgentIDQueryEngine

    documents = SimpleDirectoryReader("data").load_data()
    index = VectorStoreIndex.from_documents(documents)

    engine = AgentIDQueryEngine(
        query_engine=index.as_query_engine(),
        name="research-agent",
        capabilities=["research", "summarization"],
        owner="team@company.com",
        registry_url="https://api.agentid-protocol.com",
    )
    print(f"Agent DID: {engine.did}")

    response = engine.query("What are the main risks of AI agents?")
    print(response.response)
    # response.metadata["_agentid_did"]       → signer DID
    # response.metadata["_agentid_signature"] → Ed25519 signature
    # response.metadata["_agentid_payload"]   → signed payload

Verifying downstream::

    from agentid import Agent

    Agent.verify_from_did({
        "payload":   response.metadata["_agentid_payload"],
        "signature": response.metadata["_agentid_signature"],
    })  # → True

"""

from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


class AgentIDQueryEngine:
    """Query engine wrapper that signs every response with an AgentID identity.

    Wraps any ``llama_index.core.query_engine.BaseQueryEngine`` and attaches
    a cryptographic signature to the response metadata so downstream agents
    can verify provenance.

    Args:
        query_engine: Any LlamaIndex ``BaseQueryEngine`` instance.
        name: Human-readable agent name (used only on first run / creation).
        capabilities: Capability tags, e.g. ``["research", "summarization"]``.
        owner: Owner email or identifier.
        did: Existing DID to reload (skips creation; name/capabilities ignored).
        metadata: Extra key/value pairs to store in the agent document.
        registry_url: Remote registry URL (mutually exclusive with registry_path).
        registry_path: Local file registry path.
    """

    def __init__(
        self,
        query_engine: Any,
        name: str,
        capabilities: list[str],
        owner: str,
        did: Optional[str] = None,
        metadata: Optional[dict] = None,
        registry_url: Optional[str] = None,
        registry_path: Optional[str] = None,
    ) -> None:
        from agentid import Agent

        self._engine = query_engine
        self._registry_url = registry_url
        self._registry_path = registry_path

        if did:
            self._agent = Agent.load(
                did,
                registry_url=registry_url,
                registry_path=registry_path,
            )
        else:
            self._agent = Agent.create(
                name=name,
                capabilities=capabilities,
                owner=owner,
                metadata=metadata or {},
                registry_url=registry_url,
                registry_path=registry_path,
            )

        logger.info("[AgentID] LlamaIndex engine registered: %s", self._agent.did)

    # ── identity ──────────────────────────────────────────────────────────────

    @property
    def did(self) -> str:
        """The agent's Decentralized Identifier."""
        return self._agent.did

    @property
    def agent(self) -> Any:
        """The underlying ``agentid.Agent`` instance."""
        return self._agent

    # ── query ─────────────────────────────────────────────────────────────────

    def query(self, query: str) -> Any:
        """Run a query and sign the response.

        Args:
            query: Natural-language query string.

        Returns:
            The original LlamaIndex ``Response`` object, with AgentID
            signature fields injected into ``response.metadata``:

            - ``_agentid_did``       — signer DID
            - ``_agentid_signature`` — base64 Ed25519 signature
            - ``_agentid_payload``   — signed payload (for verification)
        """
        response = self._engine.query(query)

        # Sign the response text
        signed = self._agent.sign({
            "query": query,
            "response": str(response),
            "signer_did": self._agent.did,
        })

        # Attach to response metadata (works for both Response and StreamingResponse)
        if not hasattr(response, "metadata") or response.metadata is None:
            response.metadata = {}
        response.metadata["_agentid_did"] = self._agent.did
        response.metadata["_agentid_signature"] = signed["signature"]
        response.metadata["_agentid_payload"] = signed["payload"]

        logger.debug("[AgentID] Response signed by %s", self._agent.did[:40])
        return response

    def verify_response(self, response: Any) -> bool:
        """Verify a signed response returned by this (or any AgentID) engine.

        Args:
            response: LlamaIndex ``Response`` with AgentID metadata fields.

        Returns:
            True if the signature is valid, False otherwise.
        """
        from agentid import Agent

        metadata = getattr(response, "metadata", {}) or {}
        payload = metadata.get("_agentid_payload")
        signature = metadata.get("_agentid_signature")

        if not payload or not signature:
            logger.warning("[AgentID] Response has no AgentID signature metadata.")
            return False

        return Agent.verify_from_did(
            {"payload": payload, "signature": signature},
            registry_url=self._registry_url,
            registry_path=self._registry_path,
        )
