"""AgentID tools for CrewAI — discovery and verification."""

from __future__ import annotations

import json
from typing import Optional, Type

from crewai.tools import BaseTool
from pydantic import BaseModel, Field


class _FindInput(BaseModel):
    capability: str = Field(
        description="Capability to search for, e.g. 'web-search', 'code-review', 'translation'."
    )


class _VerifyInput(BaseModel):
    signed_message: str = Field(
        description="JSON string with 'payload' and 'signature' keys from another AgentID agent."
    )


class AgentIDFindTool(BaseTool):
    """Find other AI agents by capability using the AgentID registry.

    Useful when a CrewAI agent needs to delegate a subtask and wants to
    discover which external agents are capable of handling it.

    Usage::

        from crewai import Agent
        from crewai_agentid import AgentIDFindTool

        find_tool = AgentIDFindTool()

        researcher = Agent(
            role="Research Lead",
            goal="Coordinate research tasks",
            backstory="Expert at finding the right specialists",
            tools=[find_tool],
        )

    """

    name: str = "AgentID Find"
    description: str = (
        "Find AI agents registered in the AgentID network by capability. "
        "Use this to discover which agents can perform a specific task. "
        "Input: a capability name such as 'web-search', 'translation', 'code-review'. "
        "Returns: a JSON list of available agents with their DIDs, names, and capabilities."
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
    """Verify that a signed message came from the agent it claims.

    Use this before trusting output received from another agent in your crew
    or from an external agent.

    Usage::

        from crewai import Agent
        from crewai_agentid import AgentIDVerifyTool

        verify_tool = AgentIDVerifyTool()

        auditor = Agent(
            role="Output Auditor",
            goal="Verify all outputs before they are used",
            backstory="Ensures every message is authentic",
            tools=[verify_tool],
        )

    """

    name: str = "AgentID Verify"
    description: str = (
        "Verify that a signed message genuinely came from the agent it claims to be from. "
        "Use this before acting on output received from another agent. "
        "Input: a JSON string with 'payload' and 'signature' keys. "
        "Returns: JSON with 'valid' boolean, 'signer' DID, and a status message."
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

        signer_did = msg["payload"].get("signer", "unknown")
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
