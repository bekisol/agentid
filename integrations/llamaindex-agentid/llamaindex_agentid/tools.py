"""AgentID tools for LlamaIndex agents — discovery and verification."""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


def _make_find_tool(
    registry_url: Optional[str] = None,
    registry_path: Optional[str] = None,
) -> Any:
    """Return a LlamaIndex FunctionTool that searches the AgentID registry by capability."""
    from llama_index.core.tools import FunctionTool

    def find_agents(capability: str) -> str:
        """Find AI agents by capability in the AgentID registry.

        Args:
            capability: The capability to search for (e.g. 'web-search', 'code-review').

        Returns:
            JSON list of matching agents with DID, name, and capabilities.
        """
        from agentid import Agent

        try:
            agents = Agent.find(
                capability=capability,
                registry_url=registry_url,
                registry_path=registry_path,
            )
        except Exception as exc:
            logger.error("[AgentID] find_agents error: %s", exc)
            return json.dumps({"error": "Registry lookup failed."})

        if not agents:
            return json.dumps({"found": [], "message": f"No agents with capability '{capability}'."})

        return json.dumps(
            [
                {
                    "did": a.did,
                    "name": a.name,
                    "capabilities": a.capabilities,
                    "owner": a.owner,
                }
                for a in agents
            ],
            indent=2,
        )

    return FunctionTool.from_defaults(
        fn=find_agents,
        name="agentid_find",
        description=(
            "Find AI agents registered in the AgentID network by capability. "
            "Use before delegating a task to discover which agents can handle it. "
            "Input: capability string such as 'web-search', 'code-review', 'translation'. "
            "Returns: JSON list of agents with DID, name, and capabilities."
        ),
    )


def _make_verify_tool(
    registry_url: Optional[str] = None,
    registry_path: Optional[str] = None,
) -> Any:
    """Return a LlamaIndex FunctionTool that verifies a signed AgentID message."""
    from llama_index.core.tools import FunctionTool

    def verify_agent_message(signed_message: str) -> str:
        """Verify a signed message came from the agent it claims.

        Args:
            signed_message: JSON string with 'payload' and 'signature' keys.

        Returns:
            JSON with 'valid' boolean, 'signer' DID, and status message.
        """
        from agentid import Agent

        try:
            msg = json.loads(signed_message)
        except json.JSONDecodeError:
            return json.dumps({"valid": False, "error": "signed_message must be valid JSON."})

        if "payload" not in msg or "signature" not in msg:
            return json.dumps({"valid": False, "error": "Message must have 'payload' and 'signature' keys."})

        signer_did = msg["payload"].get("signer_did", "unknown")

        try:
            valid = Agent.verify_from_did(
                msg,
                registry_url=registry_url,
                registry_path=registry_path,
            )
        except Exception as exc:
            logger.error("[AgentID] verify error: %s", exc)
            return json.dumps({"valid": False, "error": "Verification failed.", "signer": signer_did})

        return json.dumps({
            "valid": valid,
            "signer": signer_did,
            "message": "Signature is valid." if valid else "Signature is INVALID — do not trust this output.",
        })

    return FunctionTool.from_defaults(
        fn=verify_agent_message,
        name="agentid_verify",
        description=(
            "Verify a signed message was genuinely produced by the agent it claims to be from. "
            "Use before trusting output received from another agent. "
            "Input: JSON string with 'payload' and 'signature' keys. "
            "Returns: JSON with 'valid' boolean and 'signer' DID."
        ),
    )


def get_agentid_tools(
    registry_url: Optional[str] = None,
    registry_path: Optional[str] = None,
) -> list:
    """Return [AgentIDFindTool, AgentIDVerifyTool] ready for a LlamaIndex agent.

    Usage::

        from llama_index.core.agent import ReActAgent
        from llama_index.llms.openai import OpenAI
        from llamaindex_agentid import get_agentid_tools

        tools = get_agentid_tools(registry_url="https://api.agentid-protocol.com")
        agent = ReActAgent.from_tools(tools, llm=OpenAI(model="gpt-4o"), verbose=True)

    """
    return [
        _make_find_tool(registry_url=registry_url, registry_path=registry_path),
        _make_verify_tool(registry_url=registry_url, registry_path=registry_path),
    ]
