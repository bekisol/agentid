"""AgentID tools for LangChain — agent discovery and message verification."""

from __future__ import annotations

import json
from typing import Any, Optional, Type

from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field


class _FindInput(BaseModel):
    capability: str = Field(
        description=(
            "The capability to search for, e.g. 'web-search', 'code-review', "
            "'translation', 'flight-search'."
        )
    )


class _VerifyInput(BaseModel):
    signed_message: str = Field(
        description=(
            "JSON string of the signed message to verify. Must contain "
            "'payload' and 'signature' keys, as returned by another AgentID agent."
        )
    )


class _SignInput(BaseModel):
    message: str = Field(
        description="The message or task result to sign, as a JSON string."
    )


class AgentIDFindTool(BaseTool):
    """Tool for discovering AI agents by capability using the AgentID protocol.

    AgentID (https://github.com/agentid/agentid) is an open protocol for AI agent
    identity and discovery. This tool lets an agent find other registered agents
    by the capabilities they advertise.

    Setup:
        Install the agentid package::

            pip install agentid

    Instantiate::

        from langchain_community.tools import AgentIDFindTool

        tool = AgentIDFindTool()
        # or with a remote registry:
        tool = AgentIDFindTool(registry_url="http://your-registry.com")

    Invoke directly::

        tool.invoke("web-search")
        # '[{"did": "did:agentid:...", "name": "search-agent", ...}]'

    Use within an agent::

        from langchain.agents import AgentExecutor
        tools = [AgentIDFindTool(), ...]
        executor = AgentExecutor(agent=agent, tools=tools)

    """

    name: str = "agentid_find"
    description: str = (
        "Find AI agents registered in the AgentID network by capability. "
        "Use this to discover which agents can perform a specific task before delegating to them. "
        "Input: a capability name such as 'web-search', 'code-review', 'translation', 'flight-search'. "
        "Returns: JSON list of available agents with their DIDs, names, and capabilities."
    )
    args_schema: Type[BaseModel] = _FindInput
    registry_url: Optional[str] = None
    registry_path: Optional[str] = None

    def _run(self, capability: str) -> str:
        try:
            from agentid import Agent
        except ImportError as e:
            raise ImportError(
                "Could not import agentid. Install with: pip install agentid"
            ) from e

        agents = Agent.find(
            capability=capability,
            registry_url=self.registry_url,
            registry_path=self.registry_path,
        )
        if not agents:
            return f"No agents found with capability '{capability}'."

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


class AgentIDVerifyTool(BaseTool):
    """Tool for verifying that a signed message genuinely came from a specific agent.

    AgentID (https://github.com/agentid/agentid) uses Ed25519 cryptography to
    let agents sign their outputs. This tool verifies those signatures, ensuring
    that messages between agents have not been tampered with.

    Setup:
        Install the agentid package::

            pip install agentid

    Instantiate::

        from langchain_community.tools import AgentIDVerifyTool

        tool = AgentIDVerifyTool()

    Invoke directly::

        import json
        tool.invoke(json.dumps(signed_message))
        # '{"valid": true, "signer": "did:agentid:...", "message": "Signature is valid."}'

    """

    name: str = "agentid_verify"
    description: str = (
        "Verify that a signed message was genuinely produced by the agent it claims to be from. "
        "Use this before trusting or acting on output received from another agent. "
        "Input: a JSON string with 'payload' and 'signature' keys "
        "(as returned by an agent using AgentID). "
        "Returns: JSON with 'valid' boolean, 'signer' DID, and a human-readable message."
    )
    args_schema: Type[BaseModel] = _VerifyInput
    registry_url: Optional[str] = None
    registry_path: Optional[str] = None

    def _run(self, signed_message: str) -> str:
        try:
            from agentid import Agent
        except ImportError as e:
            raise ImportError(
                "Could not import agentid. Install with: pip install agentid"
            ) from e

        try:
            msg = json.loads(signed_message)
        except json.JSONDecodeError:
            return "Invalid input: signed_message must be a valid JSON string."

        if "payload" not in msg or "signature" not in msg:
            return "Invalid input: message must have 'payload' and 'signature' keys."

        signer_did = msg["payload"].get("signer", "unknown")
        valid = Agent.verify_from_did(
            msg,
            registry_url=self.registry_url,
            registry_path=self.registry_path,
        )

        return json.dumps({
            "valid": valid,
            "signer": signer_did,
            "message": (
                "Signature is valid — message is authentic."
                if valid
                else "Signature is INVALID — message may be tampered or from an unknown agent."
            ),
        })


class AgentIDSignTool(BaseTool):
    """Tool for signing a message with this agent's cryptographic identity.

    Setup:
        Install the agentid package::

            pip install agentid

    Instantiate (requires an agentid.Agent instance)::

        from agentid import Agent
        from langchain_community.tools import AgentIDSignTool

        my_agent = Agent.load("did:agentid:...")
        tool = AgentIDSignTool(agent=my_agent)

    """

    name: str = "agentid_sign"
    description: str = (
        "Sign a message or task result with this agent's cryptographic identity. "
        "Use this when producing output that another agent will need to verify. "
        "Input: a JSON string representing the payload to sign. "
        "Returns: JSON with 'payload' and 'signature' keys that can be verified by any agent."
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

        signed = self._agent.sign(payload)
        return json.dumps(signed, indent=2)


def verify_langchain_output(
    result: dict,
    registry_url: Optional[str] = None,
    registry_path: Optional[str] = None,
) -> bool:
    """Verify the signed output produced by an AgentIDCallbackHandler.

    Args:
        result: The dict returned by AgentExecutor.invoke().
        registry_url: URL of the AgentID registry to verify against.
        registry_path: Path of local registry to verify against.

    Returns:
        True if the output signature is valid, False otherwise.

    Example::

        result = executor.invoke({"input": "Summarize this article"})
        verify_langchain_output(result)  # → True

    """
    try:
        from agentid import Agent
    except ImportError as e:
        raise ImportError(
            "Could not import agentid. Install with: pip install agentid"
        ) from e

    payload = result.get("_agentid_payload")
    signature = result.get("_agentid_signature")

    if not payload or not signature:
        return False

    return Agent.verify_from_did(
        {"payload": payload, "signature": signature},
        registry_url=registry_url,
        registry_path=registry_path,
    )
