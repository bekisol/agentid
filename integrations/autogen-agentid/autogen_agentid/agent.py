"""AgentID mixin and factory for AutoGen ConversableAgent."""

from __future__ import annotations

import json
import logging
from typing import Any, Optional, Union

logger = logging.getLogger(__name__)

# AutoGen message format:
# {"content": "...", "role": "user"|"assistant", "name": "agent_name"}
#
# AgentID extends this by appending a signed envelope:
# {"content": "...|AGENTID:{...signed json...}", "role": "...", "name": "..."}
#
# The separator is human-readable in logs and strips cleanly for LLM context.

_SEPARATOR = "\n\n---agentid---\n"


class AgentIDMixin:
    """
    Mixin that gives an AutoGen ConversableAgent a verifiable AgentID identity.

    Every outgoing message is signed. Every incoming message from another
    AgentID-aware agent can be verified before being acted on.

    Usage::

        from autogen import ConversableAgent
        from autogen_agentid import AgentIDMixin

        class MyAgent(AgentIDMixin, ConversableAgent):
            pass

        agent = MyAgent(
            name="researcher",
            agentid_capabilities=["research", "summarization"],
            agentid_owner="team@company.com",
            # agentid_registry_url="http://your-registry.com",  # optional
            llm_config={...},
        )

        print(agent.agentid_did)
        # did:agentid:7sP3V2...

    Or use the factory::

        from autogen_agentid import create_agentid_agent
        agent = create_agentid_agent(
            name="researcher",
            capabilities=["research"],
            owner="team@company.com",
            llm_config={...},
        )

    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        capabilities: list[str] = kwargs.pop("agentid_capabilities", [])
        owner: str = kwargs.pop("agentid_owner", "unknown")
        registry_url: Optional[str] = kwargs.pop("agentid_registry_url", None)
        registry_path: Optional[str] = kwargs.pop("agentid_registry_path", None)

        super().__init__(*args, **kwargs)

        from agentid import Agent

        agent_name = kwargs.get("name") or (args[0] if args else "agent")
        self._agentid = Agent.create(
            name=agent_name,
            capabilities=capabilities,
            owner=owner,
            registry_url=registry_url,
            registry_path=registry_path,
        )
        self._agentid_registry_url = registry_url
        self._agentid_registry_path = registry_path
        logger.info("[AgentID] %s registered: %s", agent_name, self._agentid.did)

    @property
    def agentid_did(self) -> str:
        """This agent's Decentralized Identifier."""
        return self._agentid.did

    @property
    def agentid(self):
        """The underlying agentid.Agent instance."""
        return self._agentid

    def _sign_content(self, content: str) -> str:
        """Append a signed envelope to a message content string."""
        signed = self._agentid.sign({"content": content, "agent_name": self.name})
        envelope = json.dumps({"did": self._agentid.did, **signed}, separators=(",", ":"))
        return f"{content}{_SEPARATOR}{envelope}"

    def generate_reply(
        self,
        messages: Optional[list[dict]] = None,
        sender: Optional[Any] = None,
        **kwargs: Any,
    ) -> Union[str, dict, None]:
        """Generate reply and sign it before sending."""
        reply = super().generate_reply(messages=messages, sender=sender, **kwargs)

        if reply is None:
            return reply

        if isinstance(reply, str):
            return self._sign_content(reply)

        if isinstance(reply, dict) and "content" in reply and reply["content"]:
            reply["content"] = self._sign_content(reply["content"])

        return reply

    def verify_message(self, message: Union[str, dict]) -> bool:
        """
        Verify an AgentID-signed message from another agent.

        Returns True if signature is valid, False if missing or invalid.

        Usage::

            if not agent.verify_message(last_message):
                raise ValueError("Message failed verification")

        """
        content = message if isinstance(message, str) else message.get("content", "")
        return verify_autogen_message(
            content,
            registry_url=self._agentid_registry_url,
            registry_path=self._agentid_registry_path,
        )


def create_agentid_agent(
    name: str,
    capabilities: list[str],
    owner: str,
    registry_url: Optional[str] = None,
    registry_path: Optional[str] = None,
    **autogen_kwargs: Any,
) -> "AgentIDConversableAgent":
    """
    Factory that creates an AutoGen ConversableAgent with AgentID identity.

    Usage::

        from autogen_agentid import create_agentid_agent

        agent = create_agentid_agent(
            name="researcher",
            capabilities=["research", "summarization"],
            owner="team@company.com",
            llm_config={"config_list": [...]},
        )

        print(agent.agentid_did)

    """
    from autogen import ConversableAgent

    class AgentIDConversableAgent(AgentIDMixin, ConversableAgent):
        pass

    return AgentIDConversableAgent(
        name,
        agentid_capabilities=capabilities,
        agentid_owner=owner,
        agentid_registry_url=registry_url,
        agentid_registry_path=registry_path,
        **autogen_kwargs,
    )


# import here to avoid circular import
from autogen_agentid.verify import verify_autogen_message  # noqa: E402
