"""
AgentID × CrewAI integration.

Gives every CrewAI agent a verifiable identity and makes
agent discovery and verification first-class tools.

Usage
-----
**First run** — create a new identity, store the DID:

    from agentid.integrations.crewai import (
        load_or_create,
        AgentIDFindTool,
        AgentIDVerifyTool,
        AgentIDSignTool,
    )

    identity, sign_tool = load_or_create(
        name="research-agent",
        capabilities=["web-search", "summarization"],
        owner="team@company.com",
        registry_url="https://api.agentid-protocol.com",
    )
    print(f"DID (store this): {identity.did}")

**Subsequent runs** — reload the same identity:

    identity, sign_tool = load_or_create(
        did=os.environ["MY_AGENT_DID"],
        name="research-agent",             # ignored when did is given
        capabilities=["web-search"],       # ignored when did is given
        owner="team@company.com",
        registry_url="https://api.agentid-protocol.com",
    )

    tools = [
        AgentIDFindTool(registry_url="https://api.agentid-protocol.com"),
        AgentIDVerifyTool(registry_url="https://api.agentid-protocol.com"),
        sign_tool,
    ]

    researcher = Agent(
        role="Researcher",
        goal="Find and verify trusted AI agents",
        tools=tools,
    )
"""

import json
import logging
from typing import Optional, Type

from pydantic import BaseModel, Field

from ..agent import Agent

logger = logging.getLogger(__name__)


# ── Helper: load-or-create ────────────────────────────────────────────────────

def load_or_create(
    *,
    name: str,
    capabilities: list[str],
    owner: str,
    did: str = None,
    metadata: dict = None,
    registry_url: str = None,
    registry_path: str = None,
) -> tuple["Agent", "AgentIDSignTool"]:
    """
    Load an existing agent by DID (or register a new one on first run) and
    return ``(agent, sign_tool)`` ready to attach to a CrewAI agent.

    Call this **once at application start** and pass the returned Agent into
    AgentIDSignTool.  Store the agent's DID (agent.did) in an env var or
    secrets manager so you reload the same identity across restarts instead
    of creating a new one every time.

    Args:
        did:          Previously stored DID.  When supplied, the agent is loaded
                      from the registry (name/capabilities/metadata are ignored).
        name:         Human-readable name — used only when creating a new agent.
        capabilities: Capability list  — used only when creating a new agent.
        owner:        Owner e-mail/identifier — used only when creating a new agent.
        metadata:     Extra metadata dict — used only when creating a new agent.
        registry_url: URL of the HTTP registry (mutually exclusive with registry_path).
        registry_path: Path to a local file registry.
    """
    if did:
        agent = Agent.load(did, registry_url=registry_url, registry_path=registry_path)
        logger.info(f"[AgentID] Loaded CrewAI agent: {agent.did}")
    else:
        agent = Agent.create(
            name=name,
            capabilities=capabilities,
            owner=owner,
            metadata=metadata or {},
            registry_url=registry_url,
            registry_path=registry_path,
        )
        logger.info(f"[AgentID] Registered CrewAI agent: {agent.did}")
    return agent, AgentIDSignTool(agent=agent)


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
        # Sanitise before use — strip control characters that could cause log injection
        capability = capability.strip()[:128]
        try:
            agents = Agent.find(
                capability=capability,
                registry_url=self.registry_url,
                registry_path=self.registry_path,
            )
        except Exception as e:
            logger.error(f"[AgentID] AgentIDFindTool error: {type(e).__name__}")
            return json.dumps({"error": "Registry lookup failed. The registry may be unavailable."})

        if not agents:
            return json.dumps({"found": [], "message": "No agents found with that capability."})

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
        # Bound size before parsing to prevent memory exhaustion
        if len(signed_message) > 65_536:
            return json.dumps({"valid": False, "error": "signed_message too large (max 64KB)"})

        try:
            msg = json.loads(signed_message)
        except json.JSONDecodeError:
            return json.dumps({"valid": False, "error": "signed_message must be valid JSON"})

        if "payload" not in msg or "signature" not in msg:
            return json.dumps({"valid": False, "error": "message must have 'payload' and 'signature' keys"})

        # Ensure payload is a dict before calling .get()
        if not isinstance(msg["payload"], dict):
            return json.dumps({"valid": False, "error": "payload must be a JSON object"})

        signer_did = msg["payload"].get("signer", "unknown")
        try:
            valid = Agent.verify_from_did(
                msg,
                registry_url=self.registry_url,
                registry_path=self.registry_path,
            )
        except Exception as e:
            logger.error(f"[AgentID] AgentIDVerifyTool error: {type(e).__name__}")
            return json.dumps({"valid": False, "error": "Registry lookup failed. The registry may be unavailable."})

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
    **First-time setup only** — register a brand-new agent and return
    ``(agent, sign_tool)``.

    This creates a fresh Ed25519 key-pair and registers it in the AgentID
    network every time it is called.  For recurring runs, use
    ``load_or_create(did=stored_did, ...)`` instead so the same cryptographic
    identity is reused rather than a new one being minted on every restart.

    Args:
        name:         Human-readable agent name.
        capabilities: List of capability strings.
        owner:        Owner e-mail or identifier.
        metadata:     Optional extra metadata dict.
        registry_url: URL of the HTTP registry.
        registry_path: Path to a local file registry.

    Returns:
        (Agent, AgentIDSignTool) — store agent.did for future ``load_or_create`` calls.
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
