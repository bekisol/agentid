"""AgentID tools for LangChain — discovery, verification, and signing."""

from __future__ import annotations

import json
from typing import Any, Optional, Type

from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field


class _FindInput(BaseModel):
    capability: str = Field(
        description="Capability to search for, e.g. 'web-search', 'code-review', 'translation'."
    )


class _VerifyInput(BaseModel):
    signed_message: str = Field(
        description="JSON string with 'payload' and 'signature' keys from another AgentID agent."
    )


class _SignInput(BaseModel):
    message: str = Field(description="JSON string of the payload to sign.")


class AgentIDFindTool(BaseTool):
    """Find AI agents by capability using the AgentID registry.

    Usage::

        from langchain_agentid import AgentIDFindTool

        tool = AgentIDFindTool()
        tool.invoke("web-search")
        # '[{"did": "did:agentid:...", "name": "search-agent", ...}]'

    """

    name: str = "agentid_find"
    description: str = (
        "Find AI agents registered in the AgentID network by capability. "
        "Use this before delegating a task to discover which agents can handle it. "
        "Input: capability name such as 'web-search', 'code-review', 'translation'. "
        "Returns: JSON list of agents with their DIDs, names, and capabilities."
    )
    args_schema: Type[BaseModel] = _FindInput
    registry_url: Optional[str] = None
    registry_path: Optional[str] = None

    def _run(self, capability: str) -> str:
        from agentid import Agent

        agents = Agent.find(
            capability=capability,
            registry_url=self.registry_url,
            registry_path=self.registry_path,
        )
        if not agents:
            return f"No agents found with capability '{capability}'."

        return json.dumps(
            [{"did": a.did, "name": a.name, "capabilities": a.capabilities, "owner": a.owner}
             for a in agents],
            indent=2,
        )


class AgentIDVerifyTool(BaseTool):
    """Verify a signed message came from the agent it claims.

    Usage::

        from langchain_agentid import AgentIDVerifyTool
        import json

        tool = AgentIDVerifyTool()
        tool.invoke(json.dumps(signed_message))
        # '{"valid": true, "signer": "did:agentid:...", "message": "Signature is valid."}'

    """

    name: str = "agentid_verify"
    description: str = (
        "Verify a signed message was genuinely produced by the agent it claims to be from. "
        "Use this before trusting output received from another agent. "
        "Input: JSON string with 'payload' and 'signature' keys. "
        "Returns: JSON with 'valid' boolean, 'signer' DID, and status message."
    )
    args_schema: Type[BaseModel] = _VerifyInput
    registry_url: Optional[str] = None
    registry_path: Optional[str] = None

    def _run(self, signed_message: str) -> str:
        from agentid import Agent

        try:
            msg = json.loads(signed_message)
        except json.JSONDecodeError:
            return "Invalid input: signed_message must be valid JSON."

        if "payload" not in msg or "signature" not in msg:
            return "Invalid input: message must have 'payload' and 'signature' keys."

        signer_did = msg["payload"].get("signer_did") or msg["payload"].get("signer", "unknown")
        valid = Agent.verify_from_did(
            msg,
            registry_url=self.registry_url,
            registry_path=self.registry_path,
        )

        return json.dumps({
            "valid": valid,
            "signer": signer_did,
            "message": "Signature is valid." if valid else "Signature is INVALID.",
        })


class AgentIDSignTool(BaseTool):
    """Sign a message with this agent's cryptographic identity."""

    name: str = "agentid_sign"
    description: str = (
        "Sign a message with this agent's identity so downstream agents can verify it. "
        "Input: JSON string of the payload. "
        "Returns: JSON with 'payload' and 'signature' keys."
    )
    args_schema: Type[BaseModel] = _SignInput
    _agent: Any = None

    def __init__(self, agent: Any, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._agent = agent

    def _run(self, message: str) -> str:
        try:
            payload = json.loads(message)
        except json.JSONDecodeError:
            payload = {"message": message}
        return json.dumps(self._agent.sign(payload), indent=2)


def verify_langchain_output(
    result: dict,
    registry_url: Optional[str] = None,
    registry_path: Optional[str] = None,
) -> bool:
    """Verify the signed output from an AgentIDCallbackHandler.

    Args:
        result: Dict returned by AgentExecutor.invoke().
        registry_url: Remote registry URL.
        registry_path: Local registry path.

    Returns:
        True if valid, False otherwise.

    Usage::

        result = executor.invoke({"input": "..."})
        verify_langchain_output(result)  # → True

    """
    from agentid import Agent

    payload = result.get("_agentid_payload")
    signature = result.get("_agentid_signature")

    if not payload or not signature:
        return False

    return Agent.verify_from_did(
        {"payload": payload, "signature": signature},
        registry_url=registry_url,
        registry_path=registry_path,
    )
