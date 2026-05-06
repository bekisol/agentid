"""
AgentBrain — the autonomous decision-making core of an AI agent.

AgentBrain connects four layers into one continuous loop:

    Perception → Judgment → Action → Memory → (next cycle)

Usage
-----
    import asyncio
    from agentid.brain import AgentBrain
    from agentid.brain.perception import GitPerception, APIPerception
    from agentid.brain.triggers import IntervalTrigger, OnChangeTrigger

    brain = AgentBrain(
        agent_did="did:agentid:...",
        api_key="agentid_...",
        mission="Monitor our payment API. Alert the team if error rate exceeds 5%.",
        anthropic_key="sk-ant-...",          # or openai_key=
    )

    brain.add_perception(
        APIPerception(url="https://api.example.com/metrics", extract="error_rate")
    )
    brain.add_trigger(IntervalTrigger(seconds=300))   # check every 5 minutes

    asyncio.run(brain.run())

Owner alerting
--------------
Set the owner DID in memory so the brain can send alerts:

    brain.memory.set_note("owner_did", "did:agentid:owner_did_here")
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional, Union

from .actions.executor import ActionExecutor, parse_action
from .judgment.engine import JudgmentEngine
from .memory.store import BrainMemory
from .perception.base import Perception
from .triggers.schedule import IntervalTrigger, DailyTrigger
from .triggers.change import OnChangeTrigger

logger = logging.getLogger(__name__)

Trigger = Union[IntervalTrigger, DailyTrigger, OnChangeTrigger]

_DEFAULT_BASE_URL = "https://api.agentid-protocol.com"


class AgentBrain:
    """
    Autonomous decision-making loop for an AI agent.

    The brain wakes up when any trigger fires, observes all perception
    sources, asks the LLM to judge whether action is needed, and executes
    whatever the LLM decides — all without human intervention.

    Parameters
    ----------
    agent_did : str
        The DID of the agent this brain belongs to.
    api_key : str
        AgentID API key for sending messages and searching agents.
    mission : str
        One-paragraph description of what the agent should monitor and
        what it should do when it finds something important.
    openai_key : str
        OpenAI API key for LLM judgment. Used as fallback if Anthropic fails.
    anthropic_key : str
        Anthropic API key for LLM judgment. Tried first (preferred).
    openai_model : str
        OpenAI model name. Default: "gpt-4o".
    anthropic_model : str
        Anthropic model name. Default: "claude-3-5-sonnet-20241022".
    base_url : str
        AgentID server base URL.
    """

    def __init__(
        self,
        agent_did: str,
        api_key: str,
        mission: str,
        openai_key: str = "",
        anthropic_key: str = "",
        openai_model: str = "gpt-4o",
        anthropic_model: str = "claude-3-5-sonnet-20241022",
        base_url: str = _DEFAULT_BASE_URL,
    ) -> None:
        if not openai_key and not anthropic_key:
            raise ValueError(
                "AgentBrain requires at least one of: openai_key, anthropic_key"
            )

        self._did = agent_did
        self._api_key = api_key
        self._mission = mission
        self._base_url = base_url
        self._running = False

        self.memory = BrainMemory(agent_did)
        self._judgment = JudgmentEngine(
            openai_key=openai_key,
            anthropic_key=anthropic_key,
            openai_model=openai_model,
            anthropic_model=anthropic_model,
        )
        self._perceptions: list[Perception] = []
        self._triggers: list[Trigger] = []

    # ── configuration (fluent API) ─────────────────────────────────────────────

    def add_perception(self, perception: Perception) -> "AgentBrain":
        """
        Register a data source for the brain to observe.

        Returns *self* so calls can be chained:

            brain.add_perception(GitPerception(...)).add_perception(APIPerception(...))
        """
        self._perceptions.append(perception)
        return self

    def add_trigger(self, trigger: Trigger) -> "AgentBrain":
        """
        Register a trigger that wakes the brain.

        Returns *self* so calls can be chained:

            brain.add_trigger(IntervalTrigger(3600)).add_trigger(OnChangeTrigger(...))
        """
        self._triggers.append(trigger)
        return self

    # ── core think cycle ───────────────────────────────────────────────────────

    async def think_once(self) -> None:
        """
        Run one full observe → judge → act cycle.

        This is the atomic unit of autonomous intelligence. Each cycle:
          1. Reads all perception sources (detects changes via BrainMemory)
          2. Passes observations to the JudgmentEngine
          3. Executes whatever actions the LLM decides
          4. Updates BrainMemory with new state tokens

        Can be called manually for testing or one-shot runs.
        """
        # ── 1. Observe ─────────────────────────────────────────────────────────
        perceptions = []
        for p in self._perceptions:
            last_state = self.memory.get_perception_state(p.name)
            try:
                data = await p.read(last_state)
                # Update stored state token right after reading
                self.memory.set_perception_state(p.name, data.state_token)
                perceptions.append(data)
                if data.changed:
                    logger.info("[brain] %s — CHANGED (token=%s)", p.name, data.state_token[:12])
                else:
                    logger.debug("[brain] %s — unchanged", p.name)
            except Exception as exc:
                logger.error("[brain] perception %r failed: %s", p.name, exc)

        if not perceptions:
            logger.warning("[brain] no perceptions configured — nothing to observe")
            return

        # ── 2. Judge ───────────────────────────────────────────────────────────
        context = self.memory.get_context()
        try:
            result = await self._judgment.judge(self._mission, perceptions, context)
        except Exception as exc:
            logger.error("[brain] judgment engine error: %s", exc)
            return

        logger.info(
            "[brain] judgment complete — should_act=%s | %s",
            result.should_act,
            result.summary,
        )

        if not result.should_act:
            logger.debug("[brain] reasoning: %s", result.reasoning)
            return

        # ── 3. Act ─────────────────────────────────────────────────────────────
        if not result.raw_actions:
            logger.info("[brain] should_act=True but no actions returned")
            return

        from agentid.runtime.client import AsyncAgentIDClient  # avoid circular import

        async with AsyncAgentIDClient(self._base_url, self._api_key) as client:
            executor = ActionExecutor(client, self._did, self.memory, self._base_url)
            for raw_action in result.raw_actions:
                action = parse_action(raw_action)
                if action:
                    logger.info("[brain] executing %s", type(action).__name__)
                    await executor.execute(action)

    # ── main loop ──────────────────────────────────────────────────────────────

    async def run(self) -> None:
        """
        Start the brain's autonomous loop. Blocks until :meth:`stop` is called.

        Each trigger runs in its own asyncio task. When any trigger fires,
        a think cycle runs. Multiple trigger fires are queued — they never
        run simultaneously (prevents duplicate actions).

        If no triggers are configured, defaults to running every hour.
        """
        self._running = True

        # Default trigger: hourly, if none configured
        triggers = self._triggers or [IntervalTrigger(seconds=3600)]
        if not self._triggers:
            logger.info("[brain] no triggers configured — defaulting to hourly interval")

        trigger_queue: asyncio.Queue[str] = asyncio.Queue()

        async def _run_trigger(trigger: Trigger) -> None:
            name = getattr(trigger, "_name", repr(trigger))
            while self._running:
                try:
                    await trigger.wait_until_next()
                except asyncio.CancelledError:
                    break
                except Exception as exc:
                    logger.error("[brain] trigger %r error: %s — retrying in 60s", name, exc)
                    await asyncio.sleep(60)
                    continue
                if self._running:
                    await trigger_queue.put(name)

        tasks = [asyncio.create_task(_run_trigger(t)) for t in triggers]
        logger.info(
            "[brain] started — %d perception(s), %d trigger(s)",
            len(self._perceptions),
            len(triggers),
        )

        try:
            while self._running:
                try:
                    trigger_name = await asyncio.wait_for(
                        trigger_queue.get(), timeout=5.0
                    )
                except asyncio.TimeoutError:
                    # Periodic check so we can exit cleanly when stop() is called
                    continue

                logger.info("[brain] trigger fired: %s", trigger_name)
                try:
                    await self.think_once()
                except Exception as exc:
                    logger.error("[brain] think cycle error: %s", exc)
                    self.memory.record_action("error", str(exc)[:300])
        finally:
            for t in tasks:
                t.cancel()
            # Wait for tasks to finish cancellation
            await asyncio.gather(*tasks, return_exceptions=True)
            logger.info("[brain] stopped")

    def stop(self) -> None:
        """Signal the brain to stop after the current think cycle completes."""
        self._running = False
        logger.info("[brain] stop requested")

    # ── convenience ───────────────────────────────────────────────────────────

    def __repr__(self) -> str:
        return (
            f"AgentBrain(did={self._did!r}, "
            f"perceptions={len(self._perceptions)}, "
            f"triggers={len(self._triggers)})"
        )
