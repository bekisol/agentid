"""
ActionExecutor — carries out the decisions made by the JudgmentEngine.

Action types
------------
send_message        Send a message to a specific agent DID.
find_and_contact    Search AgentID for agents with a capability, contact them.
alert_owner         Send an urgent message to the human owner of the agent.
store_note          Save a note in BrainMemory for future context.

All actions are executed async via the AgentID network.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from ..memory.store import BrainMemory
    from agentid.runtime.client import AsyncAgentIDClient

logger = logging.getLogger(__name__)


# ── Action dataclasses ────────────────────────────────────────────────────────


@dataclass
class SendMessageAction:
    """Send a message to a known agent DID."""
    to_did: str
    body: str
    type: str = "send_message"


@dataclass
class FindAndContactAction:
    """Search the AgentID registry for agents with *capability*, contact them."""
    capability: str
    body: str
    max_agents: int = 3
    type: str = "find_and_contact"


@dataclass
class AlertOwnerAction:
    """Send an urgent alert to the human owner of this agent."""
    body: str
    type: str = "alert_owner"


@dataclass
class StoreNoteAction:
    """Persist a note in BrainMemory for future LLM context."""
    key: str
    value: str
    type: str = "store_note"


Action = SendMessageAction | FindAndContactAction | AlertOwnerAction | StoreNoteAction


def parse_action(raw: dict) -> Optional[Action]:
    """Parse a raw dict (from LLM JSON output) into a typed Action."""
    t = raw.get("type", "")
    if t == "send_message":
        return SendMessageAction(to_did=raw["to_did"], body=raw["body"])
    elif t == "find_and_contact":
        return FindAndContactAction(
            capability=raw["capability"],
            body=raw["body"],
            max_agents=int(raw.get("max_agents", 3)),
        )
    elif t == "alert_owner":
        return AlertOwnerAction(body=raw["body"])
    elif t == "store_note":
        return StoreNoteAction(key=raw["key"], value=raw["value"])
    else:
        logger.warning("[brain] unknown action type: %s", t)
        return None


# ── ActionExecutor ────────────────────────────────────────────────────────────


class ActionExecutor:
    """
    Executes actions by calling the AgentID API.

    Parameters
    ----------
    client : AsyncAgentIDClient
        Open HTTP client (must be used inside an async context manager).
    agent_did : str
        The DID of this brain's agent (used as from_did for all messages).
    memory : BrainMemory
        Used to record what actions were taken.
    base_url : str
        AgentID server URL.
    """

    def __init__(
        self,
        client: "AsyncAgentIDClient",
        agent_did: str,
        memory: "BrainMemory",
        base_url: str = "https://api.agentid-protocol.com",
    ) -> None:
        self._client = client
        self._did = agent_did
        self._memory = memory
        self._base_url = base_url

    async def execute(self, action: Action) -> None:
        """Dispatch and execute a single action."""
        try:
            if isinstance(action, SendMessageAction):
                await self._send_message(action)
            elif isinstance(action, FindAndContactAction):
                await self._find_and_contact(action)
            elif isinstance(action, AlertOwnerAction):
                await self._alert_owner(action)
            elif isinstance(action, StoreNoteAction):
                await self._store_note(action)
        except Exception as exc:
            logger.error("[brain] action %s failed: %s", type(action).__name__, exc)
            self._memory.record_action("error", f"{type(action).__name__}: {exc}")

    async def _send_message(self, action: SendMessageAction) -> None:
        await self._client.send_message(
            from_did=self._did,
            to_did=action.to_did,
            body=action.body,
        )
        logger.info("[brain] sent message to %s", action.to_did)
        self._memory.record_action("send_message", f"→ {action.to_did}: {action.body[:80]}")

    async def _find_and_contact(self, action: FindAndContactAction) -> None:
        """Search the AgentID registry by capability and message top results."""
        http = self._client._check_client()
        try:
            resp = await http.get(
                "/agents",
                params={"capability": action.capability, "limit": action.max_agents, "verified": "true"},
            )
            agents = resp.json() if resp.is_success else []
            if isinstance(agents, dict):
                agents = agents.get("agents", agents.get("results", []))
        except Exception as exc:
            logger.warning("[brain] search failed for capability=%s: %s", action.capability, exc)
            agents = []

        if not agents:
            logger.info("[brain] no agents found for capability=%s", action.capability)
            self._memory.record_action(
                "find_and_contact",
                f"No agents found for capability={action.capability}",
            )
            return

        for agent in agents[: action.max_agents]:
            to_did = agent.get("did") or agent.get("id")
            if not to_did:
                continue
            await self._client.send_message(
                from_did=self._did,
                to_did=to_did,
                body=action.body,
            )
            logger.info("[brain] contacted %s (capability=%s)", to_did, action.capability)
            self._memory.record_action(
                "find_and_contact",
                f"capability={action.capability} → {to_did}: {action.body[:80]}",
            )

    async def _alert_owner(self, action: AlertOwnerAction) -> None:
        """
        Send to human:{owner} pseudo-DID — lands in the admin panel inbox.
        Falls back to logging if the owner DID is unknown.
        """
        owner_did = self._memory.get_note("owner_did")
        if owner_did:
            await self._client.send_message(
                from_did=self._did,
                to_did=str(owner_did),
                body=f"[BRAIN ALERT]\n\n{action.body}",
            )
            logger.info("[brain] alerted owner %s", owner_did)
        else:
            # No owner DID stored — just log
            logger.warning("[brain] alert_owner: no owner_did in memory. Message: %s", action.body[:200])
        self._memory.record_action("alert_owner", action.body[:120])

    async def _store_note(self, action: StoreNoteAction) -> None:
        self._memory.set_note(action.key, action.value)
        logger.info("[brain] stored note: %s", action.key)
        self._memory.record_action("store_note", f"{action.key}={action.value[:80]}")
