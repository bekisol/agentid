"""
AgentID × LangChain integration.

Gives every LangChain agent a verifiable identity and makes
agent discovery a first-class tool.

Usage
-----
**First run** — create a new identity and persist the DID somewhere (env var,
config file, secrets manager):

    from agentid import Agent
    from agentid.integrations.langchain import (
        load_or_create,
        AgentIDCallbackHandler,
        AgentIDFindTool,
        AgentIDVerifyTool,
    )

    # Create once, store the DID
    my_agent = load_or_create(
        name="research-agent",
        capabilities=["web-search", "summarization"],
        owner="team@company.com",
        registry_url="https://api.agentid-protocol.com",
    )
    print(f"DID (store this): {my_agent.did}")

**Subsequent runs** — reload the existing identity:

    my_agent = load_or_create(
        did=os.environ["MY_AGENT_DID"],       # pass the stored DID
        name="research-agent",                 # ignored when did is given
        capabilities=["web-search"],           # ignored when did is given
        owner="team@company.com",
        registry_url="https://api.agentid-protocol.com",
    )

    # 1. Attach identity to the LangChain executor
    handler = AgentIDCallbackHandler(my_agent)

    # 2. Add discovery tools
    tools = [
        AgentIDFindTool(registry_url="https://api.agentid-protocol.com"),
        AgentIDVerifyTool(registry_url="https://api.agentid-protocol.com"),
    ]

    # 3. Wire up
    executor = AgentExecutor(agent=agent, tools=tools, callbacks=[handler])
"""

import json
import logging
from typing import Any, Optional, Type

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

from ..agent import Agent, AgentDocument

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
) -> Agent:
    """
    Load an existing agent by DID, or register a brand-new one on first run.

    Call this **once at application start** and pass the returned Agent into
    AgentIDCallbackHandler.  Store the agent's DID (agent.did) in an env var
    or secrets manager so you can reload the same identity across restarts
    instead of creating a new one every time.

    Args:
        did:          Previously stored DID.  When supplied the agent is loaded
                      from the registry (name/capabilities/metadata are ignored).
        name:         Human-readable name — used only when creating a new agent.
        capabilities: Capability list  — used only when creating a new agent.
        owner:        Owner e-mail/identifier — used only when creating a new agent.
        metadata:     Extra metadata dict — used only when creating a new agent.
        registry_url: URL of the HTTP registry (mutually exclusive with registry_path).
        registry_path: Path to a local file registry.
    """
    if did:
        return Agent.load(did, registry_url=registry_url, registry_path=registry_path)
    return Agent.create(
        name=name,
        capabilities=capabilities,
        owner=owner,
        metadata=metadata or {},
        registry_url=registry_url,
        registry_path=registry_path,
    )


# ── Callback Handler ──────────────────────────────────────────────────────────

class AgentIDCallbackHandler(BaseCallbackHandler):
    """
    Attaches a verifiable AgentID identity to any LangChain agent.

    Accepts a pre-created Agent instance so the same cryptographic identity
    is reused across process restarts — no new key-pair is generated on every
    init.  Use ``load_or_create()`` to obtain the Agent before constructing
    this handler.

    - Signs every final output with the agent's private key
    - Logs identity info at agent start/action
    """

    def __init__(self, agent: Agent):
        super().__init__()
        self._agent = agent
        logger.info(f"[AgentID] Handler attached to agent: {self._agent.did}")

    @property
    def did(self) -> str:
        return self._agent.did

    @property
    def agent(self) -> Agent:
        return self._agent

    def on_agent_action(self, action: Any, **kwargs: Any) -> None:
        logger.debug(f"[AgentID] {self._agent.name} → tool:{action.tool}")

    def on_agent_finish(self, finish: Any, **kwargs: Any) -> None:
        """Sign the final output so downstream agents can verify it."""
        output = finish.return_values.get("output", "")
        signed = self._agent.sign({"output": output})
        finish.return_values["_agentid_did"] = self._agent.did
        finish.return_values["_agentid_signature"] = signed["signature"]
        finish.return_values["_agentid_payload"] = signed["payload"]
        logger.debug(f"[AgentID] Output signed by {self._agent.did[:40]}...")

    def on_chain_error(self, error: BaseException, **kwargs: Any) -> None:
        logger.error(f"[AgentID] {self._agent.name} chain error: {error}")


# ── Tool input schemas ────────────────────────────────────────────────────────

class FindInput(BaseModel):
    capability: str = Field(description="The capability to search for, e.g. 'web-search' or 'code-review'")


class VerifyInput(BaseModel):
    signed_message: str = Field(description="JSON string of the signed message to verify, containing 'payload' and 'signature' keys")


class SignInput(BaseModel):
    message: str = Field(description="The message or task description to sign as a JSON string")


# ── Tools ─────────────────────────────────────────────────────────────────────

class AgentIDFindTool(BaseTool):
    """Find available agents by capability."""

    name: str = "agentid_find"
    description: str = (
        "Find AI agents registered in the AgentID network by capability. "
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


class AgentIDVerifyTool(BaseTool):
    """Verify that a signed message genuinely came from the claimed agent."""

    name: str = "agentid_verify"
    description: str = (
        "Verify that a signed message was genuinely produced by the agent it claims to be from. "
        "Input: a JSON string with 'payload' and 'signature' keys (as returned by another agent). "
        "Returns: verification result and the signer's DID."
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
            "message": "Signature is valid." if valid else "Signature is INVALID — message may be tampered.",
        })


class AgentIDSignTool(BaseTool):
    """Sign a message with this agent's private key."""

    name: str = "agentid_sign"
    description: str = (
        "Sign a message or task result with this agent's cryptographic identity. "
        "Input: a JSON string representing the message to sign. "
        "Returns: the signed message including payload, signature, and signer DID."
    )
    args_schema: Type[BaseModel] = SignInput

    _agent: Optional[Agent] = None

    def __init__(self, agent: Agent, **kwargs):
        super().__init__(**kwargs)
        self._agent = agent

    def _run(self, message: str) -> str:
        try:
            payload = json.loads(message)
        except json.JSONDecodeError:
            payload = {"message": message}

        signed = self._agent.sign(payload)
        return json.dumps(signed, indent=2)


# ── Helpers ───────────────────────────────────────────────────────────────────

def verify_langchain_output(result: dict, registry_url: str = None, registry_path: str = None) -> bool:
    """
    Verify the signed output produced by an AgentIDCallbackHandler.

    result is the dict returned by AgentExecutor.invoke().
    Returns True if the output signature is valid.
    """
    payload = result.get("_agentid_payload")
    signature = result.get("_agentid_signature")

    if not payload or not signature:
        return False

    return Agent.verify_from_did(
        {"payload": payload, "signature": signature},
        registry_url=registry_url,
        registry_path=registry_path,
    )
