"""
AgentID × AutoGen integration.

Works with both AutoGen v0.2.x (pyautogen) and v0.4+ (autogen-agentchat).

── AutoGen v0.2 usage ────────────────────────────────────────────────────────

    from agentid.integrations.autogen import AgentIDTools

    agentid = AgentIDTools(
        registry_url="https://agentid-commercial-features-production.up.railway.app"
    )

    # Register tools on your agents
    agentid.register_v2(assistant, user_proxy)

    # Now the assistant can call agentid_find and agentid_verify
    # and user_proxy will execute them.


── AutoGen v0.4+ usage ───────────────────────────────────────────────────────

    from agentid.integrations.autogen import AgentIDTools

    agentid = AgentIDTools(
        registry_url="https://agentid-commercial-features-production.up.railway.app"
    )

    # Get tools as FunctionTool objects
    tools = agentid.as_tools()   # list of autogen.tools.FunctionTool

    agent = AssistantAgent(
        name="assistant",
        tools=tools,
    )


── Giving an AutoGen agent its own identity ──────────────────────────────────

    from agentid.integrations.autogen import AgentIDTools, create_agentid_agent

    identity = create_agentid_agent(
        name="my-autogen-agent",
        capabilities=["data-analysis", "code-execution"],
        owner="team@company.com",
        registry_url="https://agentid-commercial-features-production.up.railway.app",
    )
    print(f"Agent DID: {identity.did}")

    # Sign outputs before sending to other agents
    signed = identity.sign({"result": "analysis complete", "data": [...]})
"""

import json
import logging
from typing import Callable, Optional

from ..agent import Agent

logger = logging.getLogger(__name__)


# ── Core tool functions (plain Python — framework-agnostic) ───────────────────

def _make_find_fn(registry_url: Optional[str], registry_path: Optional[str]) -> Callable:
    def agentid_find(capability: str) -> str:
        """
        Find AI agents registered in the AgentID network by capability.
        Returns a JSON list of matching agents with their DIDs and capabilities.
        """
        agents = Agent.find(
            capability=capability,
            registry_url=registry_url,
            registry_path=registry_path,
        )
        if not agents:
            return json.dumps({"found": [], "message": f"No agents found with capability '{capability}'."})

        return json.dumps(
            {
                "found": [
                    {
                        "did": a.did,
                        "name": a.name,
                        "capabilities": a.capabilities,
                        "owner": a.owner,
                    }
                    for a in agents
                ]
            },
            indent=2,
        )

    agentid_find.__doc__ = (
        "Find AI agents registered in the AgentID network by capability. "
        "Input: capability (str) — the capability to search for, "
        "e.g. 'web-search', 'code-review', 'translation'. "
        "Returns: JSON list of agents with their DIDs, names, and capabilities."
    )
    return agentid_find


def _make_verify_fn(registry_url: Optional[str], registry_path: Optional[str]) -> Callable:
    def agentid_verify(signed_message_json: str) -> str:
        """
        Verify that a signed message genuinely came from the agent it claims to be from.
        Input: JSON string with 'payload' and 'signature' keys.
        Returns: JSON object with 'valid' boolean, 'signer' DID, and a human-readable message.
        """
        try:
            msg = json.loads(signed_message_json)
        except json.JSONDecodeError:
            return json.dumps({"valid": False, "error": "signed_message_json must be valid JSON"})

        if "payload" not in msg or "signature" not in msg:
            return json.dumps({"valid": False, "error": "message must have 'payload' and 'signature' keys"})

        signer_did = msg["payload"].get("signer", "unknown")
        valid = Agent.verify_from_did(
            msg,
            registry_url=registry_url,
            registry_path=registry_path,
        )

        return json.dumps({
            "valid": valid,
            "signer": signer_did,
            "message": "Signature is valid." if valid else "Signature INVALID — message may be tampered.",
        })

    return agentid_verify


def _make_resolve_fn(registry_url: Optional[str], registry_path: Optional[str]) -> Callable:
    def agentid_resolve(did: str) -> str:
        """
        Resolve an agent DID to its public document.
        Input: did (str) — the agent's DID, e.g. 'did:agentid:...'
        Returns: JSON agent document with name, capabilities, owner, and public key.
        """
        doc = Agent.resolve(did, registry_url=registry_url, registry_path=registry_path)
        if not doc:
            return json.dumps({"found": False, "message": f"Agent not found: {did}"})
        return json.dumps({
            "found": True,
            "did": doc.did,
            "name": doc.name,
            "capabilities": doc.capabilities,
            "owner": doc.owner,
            "metadata": doc.metadata,
        }, indent=2)

    return agentid_resolve


def _make_sign_fn(agent: Agent) -> Callable:
    def agentid_sign(message: str) -> str:
        """
        Sign a message with this agent's private key.
        Input: message (str) — plain text or JSON string to sign.
        Returns: JSON with 'payload', 'signature', and 'signer' DID.
        """
        try:
            payload = json.loads(message)
        except json.JSONDecodeError:
            payload = {"message": message}

        signed = agent.sign(payload)
        return json.dumps(signed, indent=2)

    return agentid_sign


# ── AgentIDTools class ────────────────────────────────────────────────────────

class AgentIDTools:
    """
    AgentID tools packaged for AutoGen.

    Supports both v0.2 (register_v2) and v0.4+ (as_tools).
    """

    def __init__(
        self,
        registry_url: str = None,
        registry_path: str = None,
        agent: Agent = None,  # optional — enables the sign tool
    ):
        self.registry_url = registry_url
        self.registry_path = registry_path
        self._agent = agent

        # Build the plain functions
        self._find = _make_find_fn(registry_url, registry_path)
        self._verify = _make_verify_fn(registry_url, registry_path)
        self._resolve = _make_resolve_fn(registry_url, registry_path)
        self._sign = _make_sign_fn(agent) if agent else None

    # ── AutoGen v0.2.x ────────────────────────────────────────────────────────

    def register_v2(self, llm_agent, executor_agent) -> None:
        """
        Register AgentID tools on an AutoGen v0.2 assistant + user_proxy pair.

        Args:
            llm_agent:      The AssistantAgent (describes tools to the LLM)
            executor_agent: The UserProxyAgent (executes tool calls)

        Example:
            agentid = AgentIDTools(registry_url="...")
            agentid.register_v2(assistant, user_proxy)
        """
        tools = [
            (self._find,    "Find AI agents by capability in the AgentID registry"),
            (self._verify,  "Verify a signed message from another AI agent"),
            (self._resolve, "Resolve an agent DID to its public document"),
        ]
        if self._sign:
            tools.append((self._sign, "Sign a message with this agent's private key"))

        for fn, description in tools:
            executor_agent.register_for_execution()(fn)
            llm_agent.register_for_llm(description=description)(fn)

        logger.info(f"[AgentID] Registered {len(tools)} tools on AutoGen v0.2 agents")

    # ── AutoGen v0.4+ ─────────────────────────────────────────────────────────

    def as_tools(self) -> list:
        """
        Return AgentID tools as a list of autogen FunctionTool objects (v0.4+).

        Example:
            from autogen_agentchat.agents import AssistantAgent
            agentid = AgentIDTools(registry_url="...")
            agent = AssistantAgent(name="assistant", tools=agentid.as_tools())
        """
        try:
            from autogen_core.tools import FunctionTool
        except ImportError:
            try:
                from autogen.tools import FunctionTool
            except ImportError:
                raise ImportError(
                    "AutoGen v0.4+ is not installed. "
                    "Install with: pip install autogen-agentchat"
                )

        tools = [
            FunctionTool(self._find,    description="Find AI agents by capability in the AgentID registry"),
            FunctionTool(self._verify,  description="Verify a signed message from another AI agent"),
            FunctionTool(self._resolve, description="Resolve an agent DID to its public document"),
        ]
        if self._sign:
            tools.append(FunctionTool(self._sign, description="Sign a message with this agent's private key"))

        return tools

    # ── Plain functions (if you want to wire up manually) ─────────────────────

    @property
    def find(self) -> Callable:
        """Plain Python function: agentid_find(capability: str) -> str"""
        return self._find

    @property
    def verify(self) -> Callable:
        """Plain Python function: agentid_verify(signed_message_json: str) -> str"""
        return self._verify

    @property
    def resolve(self) -> Callable:
        """Plain Python function: agentid_resolve(did: str) -> str"""
        return self._resolve

    @property
    def sign(self) -> Optional[Callable]:
        """Plain Python function: agentid_sign(message: str) -> str (None if no agent provided)"""
        return self._sign


# ── Convenience factory ───────────────────────────────────────────────────────

def create_agentid_agent(
    name: str,
    capabilities: list[str],
    owner: str,
    metadata: dict = None,
    registry_url: str = None,
    registry_path: str = None,
) -> Agent:
    """
    Register a new agent in the AgentID network and return the Agent object.

    The returned agent can:
    - Sign outputs:  signed = agent.sign({"result": "..."})
    - Be resolved:   Agent.resolve(agent.did, registry_url="...")

    Example:
        identity = create_agentid_agent(
            name="data-analyst",
            capabilities=["data-analysis", "code-execution"],
            owner="team@company.com",
            registry_url="https://agentid-commercial-features-production.up.railway.app",
        )
        tools = AgentIDTools(registry_url="...", agent=identity)
    """
    agent = Agent.create(
        name=name,
        capabilities=capabilities,
        owner=owner,
        metadata=metadata or {},
        registry_url=registry_url,
        registry_path=registry_path,
    )
    logger.info(f"[AgentID] Registered AutoGen agent: {agent.did}")
    return agent
