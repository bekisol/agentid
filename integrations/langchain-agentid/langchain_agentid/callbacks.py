"""AgentID callback handler for LangChain."""

from __future__ import annotations

import logging
from typing import Any, Optional

from langchain_core.callbacks import BaseCallbackHandler

logger = logging.getLogger(__name__)


class AgentIDCallbackHandler(BaseCallbackHandler):
    """Attaches a verifiable AgentID identity to any LangChain agent.

    Every output is cryptographically signed with the agent's Ed25519 key.
    Downstream agents can verify the signature using only the signer's DID.

    Install::

        pip install langchain-agentid

    Usage::

        from langchain_agentid import AgentIDCallbackHandler, AgentIDFindTool

        identity = AgentIDCallbackHandler(
            name="research-agent",
            capabilities=["web-search", "summarization"],
            owner="team@company.com",
        )
        print(identity.did)
        # did:agentid:7sP3V2mNkQxRtYbLcDfHgJwAeUiMoZnXvBqKpTsWyE

        executor = AgentExecutor(
            agent=agent,
            tools=[AgentIDFindTool(), ...],
            callbacks=[identity],
        )

        result = executor.invoke({"input": "Research AI safety"})

        from langchain_agentid import verify_langchain_output
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
        super().__init__()
        from agentid import Agent

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
        logger.info("[AgentID] Registered: %s", self._agent.did)

    @property
    def did(self) -> str:
        """The agent's Decentralized Identifier."""
        return self._agent.did

    @property
    def agent(self) -> Any:
        """The underlying agentid.Agent instance."""
        return self._agent

    def on_agent_action(self, action: Any, **kwargs: Any) -> None:
        logger.debug("[AgentID] %s → %s", self._agent.name, action.tool)

    def on_agent_finish(self, finish: Any, **kwargs: Any) -> None:
        output = finish.return_values.get("output", "")
        signed = self._agent.sign({"output": output})
        finish.return_values["_agentid_did"] = self._agent.did
        finish.return_values["_agentid_signature"] = signed["signature"]
        finish.return_values["_agentid_payload"] = signed["payload"]

    def on_chain_error(self, error: BaseException, **kwargs: Any) -> None:
        logger.error("[AgentID] %s error: %s", self._agent.name, error)
