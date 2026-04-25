"""Callback handler for AgentID — identity and trust for AI agents."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Optional

from langchain_core.callbacks import BaseCallbackHandler

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    pass


class AgentIDCallbackHandler(BaseCallbackHandler):
    """Callback handler that attaches a verifiable AgentID identity to a LangChain agent.

    AgentID (https://github.com/agentid/agentid) is an open protocol for AI agent
    identity, discovery, and trust. This handler:

    - Registers the agent in the AgentID registry on initialization
    - Cryptographically signs every final output with the agent's Ed25519 private key
    - Exposes the agent's DID (Decentralized Identifier) for use by other agents

    Setup:
        Install the agentid package::

            pip install agentid

    Instantiate::

        from langchain_community.callbacks import AgentIDCallbackHandler

        handler = AgentIDCallbackHandler(
            name="research-agent",
            capabilities=["web-search", "summarization"],
            owner="team@company.com",
            # registry_url="http://your-registry.com",  # optional, local if omitted
        )
        print(handler.did)
        # did:agentid:7sP3V2mNkQxRtYbLcDfHgJwAeUiMoZnXvBqKpTsWyE

    Use::

        from langchain.agents import AgentExecutor
        from langchain_community.callbacks import AgentIDCallbackHandler
        from langchain_community.tools import AgentIDFindTool, AgentIDVerifyTool

        identity = AgentIDCallbackHandler(
            name="research-agent",
            capabilities=["web-search", "summarization"],
            owner="team@company.com",
        )

        executor = AgentExecutor(
            agent=agent,
            tools=[AgentIDFindTool(), AgentIDVerifyTool(), ...],
            callbacks=[identity],
        )

        result = executor.invoke({"input": "Research recent AI papers"})

        # Verify the output came from this agent
        from langchain_community.tools.agentid.tool import verify_langchain_output
        verify_langchain_output(result)  # → True

    """

    def __init__(
        self,
        name: str,
        capabilities: list[str],
        owner: str,
        metadata: Optional[dict] = None,
        registry_url: Optional[str] = None,
        registry_path: Optional[str] = None,
    ) -> None:
        """Initialize and register the agent.

        Args:
            name: Human-readable name for this agent.
            capabilities: List of capability identifiers, e.g. ["web-search", "summarization"].
            owner: Owner email or identifier for this agent.
            metadata: Optional additional metadata to store with the agent document.
            registry_url: URL of a remote AgentID registry. Uses local registry if omitted.
            registry_path: Path for the local registry. Defaults to ~/.agentid/.
        """
        super().__init__()
        try:
            from agentid import Agent
        except ImportError as e:
            raise ImportError(
                "Could not import agentid. Install with: pip install agentid"
            ) from e

        self._agent = Agent.create(
            name=name,
            capabilities=capabilities,
            owner=owner,
            metadata=metadata or {},
            registry_url=registry_url,
            registry_path=registry_path,
        )
        self._registry_url = registry_url
        self._registry_path = registry_path
        logger.info("[AgentID] Registered agent: %s", self._agent.did)

    @property
    def did(self) -> str:
        """The agent's Decentralized Identifier (DID)."""
        return self._agent.did

    @property
    def agent(self) -> Any:
        """The underlying agentid.Agent instance."""
        return self._agent

    def on_agent_action(self, action: Any, **kwargs: Any) -> None:
        logger.debug("[AgentID] %s → tool: %s", self._agent.name, action.tool)

    def on_agent_finish(self, finish: Any, **kwargs: Any) -> None:
        """Sign the final output for downstream verification."""
        output = finish.return_values.get("output", "")
        signed = self._agent.sign({"output": output})
        finish.return_values["_agentid_did"] = self._agent.did
        finish.return_values["_agentid_signature"] = signed["signature"]
        finish.return_values["_agentid_payload"] = signed["payload"]
        logger.debug("[AgentID] Output signed by %s", self._agent.did[:40])

    def on_chain_error(self, error: BaseException, **kwargs: Any) -> None:
        logger.error("[AgentID] %s chain error: %s", self._agent.name, error)
