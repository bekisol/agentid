"""
AgentID × CrewAI integration.

Gives every CrewAI agent a verifiable identity and makes
agent discovery and verification first-class tools.

Usage:
    from agentid.integrations.crewai import (
        AgentIDFindTool,
        AgentIDVerifyTool,
        AgentIDSignTool,
        create_agentid_agent,
    )

    # 1. Add discovery tools to your crew
    tools = [
        AgentIDFindTool(registry_url="https://agentid-commercial-features-production.up.railway.app"),
        AgentIDVerifyTool(registry_url="https://agentid-commercial-features-production.up.railway.app"),
    ]

    researcher = Agent(
        role="Researcher",
        goal="Find and verify trusted AI agents",
        tools=tools,
    )

    # 2. Give a CrewAI agent its own verifiable identity
    identity, sign_tool = create_agentid_agent(
        name="research-agent",
        capabilities=["web-search", "summarization"],
        owner="team@company.com",
        registry_url="https://agentid-commercial-features-production.up.railway.app",
    )
    print(f"Agent DID: {identity.did}")

    researcher = Agent(
        role="Researcher",
        goal="Find and verify trusted AI agents",
        tools=[*tools, sign_tool],
    )
"""

import json
import logging
from typing import Optional, Type

from pydantic import BaseModel, Field

from ..agent import Agent

logger = logging.getLogger(__name__)

# ── Try to import CrewAI's BaseTool; fall back to LangChain (CrewAI accepts both) ──

try:
    from crewai.tools import BaseTool as CrewBaseTool
    _BASE = CrewBaseTool
except ImportError:
    try:
        from langchain_core.tools import BaseTool as LCBaseTool
        _BASE = LCBaseTool
    except ImportError:
        raise ImportError(
            "Neither crewai nor langchain-core is installed. "
            "Install one: pip install crewai  OR  pip install langchain-core"
        )


# ── Input schemas ─────────────────────────────────────────────────────────────

class FindInput(BaseModel):
    capability: str = Field(
        description="The capability to search for, e.g. 'web-search', 'code-review', 'translation'"
    )


class VerifyInput(BaseModel):
    signed_message: str = Field(
        description=(
            "JSON string of the signed message to verify. "
            "Must contain 'payload' and 'signature' keys."
        )
    )


class SignInput(BaseModel):
    message: str = Field(
        description="The message or task result to sign, as a plain string or JSON string."
    )


# ── Tools ─────────────────────────────────────────────────────────────────────

class AgentIDFindTool(_BASE):
    """Find AI agents registered in the AgentID network by capability."""

    name: str = "agentid_find"
    description: str = (
        "Find AI agents registered in the AgentID network by capability. "
        "Use this when you need to discover which agents can perform a specific task. "
        "Input: a capability name (e.g. 'flight-search', 'code-review', 'translation'). "
        "Returns: a list of available agents with their DIDs, names, and capabilities."
    )
    args_schema: Type[BaseModel] = FindInput
    registry_url: Optional[str] = None
    registry_path: Optional[str] = None

    def _run(self, capability: str) -> str:
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


class AgentIDVerifyTool(_BASE):
    """Verify that a signed message genuinely came from the agent it claims to be from."""

    name: str = "agentid_verify"
    description: str = (
        "Verify that a signed message was genuinely produced by the AI agent it claims to be from. "
        "Use this before trusting output from another agent. "
        "Input: a JSON string with 'payload' and 'signature' keys. "
        "Returns: whether the signature is valid and who signed it."
    )
    args_schema: Type[BaseModel] = VerifyInput
    registry_url: Optional[str] = None
    registry_path: Optional[str] = None

    def _run(self, signed_message: str) -> str:
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
            "message": "Signature is valid." if valid else "Signature INVALID — message may be tampered.",
        })


class AgentIDSignTool(_BASE):
    """Sign a message with this agent's private key to prove authenticity."""

    name: str = "agentid_sign"
    description: str = (
        "Sign a message or task result with this agent's cryptographic identity. "
        "Use this before sending output to another agent so they can verify it came from you. "
        "Input: the message or result to sign (string or JSON string). "
        "Returns: the signed message with payload, signature, and your DID."
    )
    args_schema: Type[BaseModel] = SignInput

    _agent: Optional[Agent] = None

    def __init__(self, agent: Agent, **kwargs):
        super().__init__(**kwargs)
        object.__setattr__(self, "_agent", agent)

    def _run(self, message: str) -> str:
        try:
            payload = json.loads(message)
        except json.JSONDecodeError:
            payload = {"message": message}

        signed = self._agent.sign(payload)
        return json.dumps(signed, indent=2)


# ── Convenience factory ───────────────────────────────────────────────────────

def create_agentid_agent(
    name: str,
    capabilities: list[str],
    owner: str,
    metadata: dict = None,
    registry_url: str = None,
    registry_path: str = None,
) -> tuple[Agent, AgentIDSignTool]:
    """
    Register a new agent in the AgentID network and return:
    - the Agent object (with .did, .sign(), etc.)
    - a ready-to-use AgentIDSignTool pre-loaded with its private key

    Add the sign tool to your CrewAI agent's tools list so it can
    sign its outputs for other agents to verify.
    """
    agent = Agent.create(
        name=name,
        capabilities=capabilities,
        owner=owner,
        metadata=metadata or {},
        registry_url=registry_url,
        registry_path=registry_path,
    )
    logger.info(f"[AgentID] Registered CrewAI agent: {agent.did}")
    sign_tool = AgentIDSignTool(agent=agent)
    return agent, sign_tool
