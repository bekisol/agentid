"""
AgentBrain — the autonomous decision-making core of an AI agent.

Connects perception, judgment, actions, memory, and triggers into one loop:

    Trigger fires
        ↓
    Read perceptions (optional structured sources)
        ↓
    LLM researches with tools (web_search, fetch_url, custom)
        ↓
    LLM judges: should_act? what actions?
        ↓
    Execute actions via AgentID network
        ↓
    Update memory → repeat

Usage
-----
    import asyncio
    from agentid.brain import AgentBrain
    from agentid.brain.providers import AnthropicProvider  # or OpenAIProvider, GeminiProvider
    from agentid.brain.tools import WebSearchTool, FetchURLTool
    from agentid.brain.triggers import IntervalTrigger

    brain = AgentBrain(
        agent_did="did:agentid:...",
        api_key="agentid_...",
        mission=\"\"\"
            You monitor the oil market for a $2B investment fund.
            Research Brent crude prices, OPEC news, and geopolitical events
            every cycle. Alert the portfolio manager if anything materially
            affects our positions.
        \"\"\",
        provider=AnthropicProvider(api_key="sk-ant-..."),
        tools=[
            WebSearchTool(api_key="BSA..."),   # Brave Search (recommended)
            FetchURLTool(),
        ],
    )

    brain.memory.set_note("owner_did", "did:agentid:portfolio_manager")
    brain.add_trigger(IntervalTrigger(seconds=3600))

    asyncio.run(brain.run())

Swapping providers
------------------
    # GPT-4o
    from agentid.brain.providers import OpenAIProvider
    provider = OpenAIProvider(api_key="sk-...")

    # Grok (xAI)
    provider = OpenAIProvider(api_key="xai-...", base_url="https://api.x.ai/v1", model="grok-3")

    # Gemini
    from agentid.brain.providers import GeminiProvider
    provider = GeminiProvider(api_key="AIza...")

    # Mistral
    provider = OpenAIProvider(api_key="...", base_url="https://api.mistral.ai/v1",
                               model="mistral-large-latest")

    # Ollama (local, free)
    provider = OpenAIProvider(api_key="ollama", base_url="http://localhost:11434/v1",
                               model="llama3.2")

Custom tools
------------
    from agentid.brain.tools import Tool

    class StockPriceTool(Tool):
        name = "get_stock_price"
        description = "Get the current price of a stock or commodity."
        parameters = {
            "type": "object",
            "properties": {
                "ticker": {"type": "string", "description": "e.g. BZ=F for Brent crude"}
            },
            "required": ["ticker"],
        }

        async def run(self, ticker: str) -> str:
            # call your market data API here
            return f"{ticker}: $85.42"

    brain = AgentBrain(..., tools=[WebSearchTool(), StockPriceTool()])
"""

from __future__ import annotations

import asyncio
import logging
from typing import Union

from .actions.executor import ActionExecutor, parse_action
from .judgment.engine import JudgmentEngine
from .memory.store import BrainMemory
from .perception.base import Perception
from .providers.base import LLMProvider
from .tools.base import Tool
from .tools.web_search import WebSearchTool
from .tools.fetch_url import FetchURLTool
from .triggers.schedule import IntervalTrigger, DailyTrigger
from .triggers.change import OnChangeTrigger

logger = logging.getLogger(__name__)

Trigger = Union[IntervalTrigger, DailyTrigger, OnChangeTrigger]

_DEFAULT_BASE_URL = "https://api.agentid-protocol.com"

# Map of shorthand tool names to their classes
_BUILTIN_TOOLS: dict[str, type[Tool]] = {
    "web_search": WebSearchTool,
    "fetch_url": FetchURLTool,
}


class AgentBrain:
    """
    Autonomous decision-making loop for an AI agent.

    The brain wakes up on triggers, researches with LLM tool use, judges
    whether action is needed, and acts — all without human intervention.
    Works with any AI provider and any data domain.

    Parameters
    ----------
    agent_did : str
        The DID of the agent this brain belongs to.
    api_key : str
        AgentID API key for sending messages and searching agents.
    mission : str
        Plain-English description of what the agent should monitor and do.
        The LLM reads this every cycle to guide its research and judgment.
    provider : LLMProvider
        AI model provider (AnthropicProvider, OpenAIProvider, GeminiProvider, …).
    tools : list[Tool | str] | None
        Tools available to the LLM for research. Pass Tool instances or
        shorthand strings ("web_search", "fetch_url"). Default: both built-in tools.
    search_api_key : str
        Brave Search API key for WebSearchTool. Only used when tools="web_search"
        is specified as a string shorthand.
    base_url : str
        AgentID server base URL.
    """

    def __init__(
        self,
        agent_did: str,
        api_key: str,
        mission: str,
        provider: LLMProvider,
        tools: list[Tool | str] | None = None,
        search_api_key: str = "",
        base_url: str = _DEFAULT_BASE_URL,
    ) -> None:
        self._did = agent_did
        self._api_key = api_key
        self._mission = mission
        self._base_url = base_url
        self._running = False

        self.memory = BrainMemory(agent_did)

        # Resolve tools (strings → instances, defaults if None)
        resolved_tools = _resolve_tools(
            tools if tools is not None else ["web_search", "fetch_url"],
            search_api_key=search_api_key,
        )

        self._judgment = JudgmentEngine(
            provider=provider,
            tools=resolved_tools,
        )
        self._perceptions: list[Perception] = []
        self._triggers: list[Trigger] = []
        self._mcp_sessions: list = []   # MCPSession instances managed by this brain

    # ── fluent configuration ───────────────────────────────────────────────────

    def add_perception(self, perception: Perception) -> "AgentBrain":
        """
        Register a structured data source (git repo, file, HTTP endpoint).

        Perceptions are optional — the LLM can also research freely with tools.
        Returns *self* for chaining.
        """
        self._perceptions.append(perception)
        return self

    def add_trigger(self, trigger: Trigger) -> "AgentBrain":
        """
        Register a trigger that wakes the brain.

        Returns *self* for chaining.
        """
        self._triggers.append(trigger)
        return self

    async def add_mcp_server(
        self,
        command: str,
        args: list[str] | None = None,
        env: dict | None = None,
        *,
        url: str | None = None,
        headers: dict | None = None,
    ) -> "AgentBrain":
        """
        Connect to an MCP server and add all its tools to the brain.

        The session stays alive for the brain's lifetime and is closed
        automatically when the brain stops.

        Parameters
        ----------
        command : str
            Executable for stdio transport (e.g. "npx", "uvx", "python").
            Ignored when *url* is provided.
        args : list[str]
            Arguments for the stdio command
            (e.g. ["-y", "@modelcontextprotocol/server-brave-search"]).
        env : dict | None
            Extra environment variables for the subprocess
            (e.g. {"BRAVE_API_KEY": "BSA..."}).
        url : str | None
            If provided, connect via HTTP instead of stdio.
        headers : dict | None
            Extra HTTP headers for the HTTP transport.

        Returns
        -------
        AgentBrain
            *self*, so calls can be chained with await:
            ``await brain.add_mcp_server(...).add_trigger(...)``
            (returns self after await, so chaining works normally after).

        Example
        -------
            brain = AgentBrain(...)
            await brain.add_mcp_server(
                "npx", ["-y", "@modelcontextprotocol/server-brave-search"],
                env={"BRAVE_API_KEY": "BSA..."},
            )
            await brain.add_mcp_server(
                "npx", ["-y", "@modelcontextprotocol/server-github"],
                env={"GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."},
            )
            await brain.run()
        """
        from .tools.mcp import MCPSession

        if url:
            session = MCPSession.http(url, headers)
        else:
            session = MCPSession.stdio(command, args or [], env)

        await session.connect()
        tools = await session.tools()

        for tool in tools:
            self._judgment.add_tool(tool)

        self._mcp_sessions.append(session)
        logger.info(
            "[brain] MCP server connected: %s — %d tool(s) added: %s",
            session,
            len(tools),
            [t.name for t in tools],
        )
        return self

    # ── core think cycle ───────────────────────────────────────────────────────

    async def think_once(self) -> None:
        """
        Run one full research → judge → act cycle.

        Steps:
          1. Read all perception sources (if any configured)
          2. Pass observations + mission to JudgmentEngine
          3. LLM researches with tools, then outputs a decision
          4. Execute actions (send messages, find agents, alert owner)
          5. Update BrainMemory

        Can be called manually for one-shot runs or testing.
        """
        # ── 1. Observe structured perceptions ──────────────────────────────────
        perceptions = []
        for p in self._perceptions:
            last_state = self.memory.get_perception_state(p.name)
            try:
                data = await p.read(last_state)
                self.memory.set_perception_state(p.name, data.state_token)
                perceptions.append(data)
                if data.changed:
                    logger.info("[brain] %s — CHANGED", p.name)
                else:
                    logger.debug("[brain] %s — unchanged", p.name)
            except Exception as exc:
                logger.error("[brain] perception %r failed: %s", p.name, exc)

        # ── 2. Judge (LLM researches + decides) ────────────────────────────────
        context = self.memory.get_context()
        try:
            result = await self._judgment.judge(self._mission, perceptions, context)
        except Exception as exc:
            logger.error("[brain] judgment error: %s", exc)
            return

        logger.info(
            "[brain] judgment: should_act=%s — %s",
            result.should_act,
            result.summary,
        )

        if not result.should_act or not result.raw_actions:
            return

        # ── 3. Act ─────────────────────────────────────────────────────────────
        from agentid.runtime.client import AsyncAgentIDClient

        async with AsyncAgentIDClient(self._base_url, self._api_key) as client:
            executor = ActionExecutor(client, self._did, self.memory, self._base_url)
            for raw in result.raw_actions:
                action = parse_action(raw)
                if action:
                    logger.info("[brain] executing %s", type(action).__name__)
                    await executor.execute(action)

    # ── main loop ──────────────────────────────────────────────────────────────

    async def run(self) -> None:
        """
        Start the autonomous loop. Blocks until :meth:`stop` is called.

        Each trigger runs in its own asyncio task. When any fires, a think
        cycle runs. Multiple simultaneous triggers are queued — cycles never
        overlap (prevents duplicate actions).

        Defaults to hourly if no triggers are configured.
        """
        self._running = True
        triggers = self._triggers or [IntervalTrigger(seconds=3600)]
        if not self._triggers:
            logger.info("[brain] no triggers set — defaulting to hourly")

        queue: asyncio.Queue[str] = asyncio.Queue()

        async def _run_trigger(t: Trigger) -> None:
            n = getattr(t, "_name", repr(t))
            while self._running:
                try:
                    await t.wait_until_next()
                except asyncio.CancelledError:
                    break
                except Exception as exc:
                    logger.error("[brain] trigger %r error: %s — retry in 60s", n, exc)
                    await asyncio.sleep(60)
                    continue
                if self._running:
                    await queue.put(n)

        tasks = [asyncio.create_task(_run_trigger(t)) for t in triggers]
        logger.info(
            "[brain] started — provider=%s, perceptions=%d, triggers=%d",
            self._judgment._provider.name,
            len(self._perceptions),
            len(triggers),
        )

        try:
            while self._running:
                try:
                    name = await asyncio.wait_for(queue.get(), timeout=5.0)
                except asyncio.TimeoutError:
                    continue

                logger.info("[brain] trigger: %s", name)
                try:
                    await self.think_once()
                except Exception as exc:
                    logger.error("[brain] think cycle error: %s", exc)
                    self.memory.record_action("error", str(exc)[:300])
        finally:
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            # Close all MCP server sessions
            for session in self._mcp_sessions:
                try:
                    await session.close()
                except Exception as exc:
                    logger.warning("[brain] MCP session close error: %s", exc)
            logger.info("[brain] stopped")

    def stop(self) -> None:
        """Signal the brain to stop after the current cycle completes."""
        self._running = False

    def __repr__(self) -> str:
        return (
            f"AgentBrain(did={self._did!r}, "
            f"provider={self._judgment._provider.name}, "
            f"perceptions={len(self._perceptions)}, "
            f"triggers={len(self._triggers)})"
        )


# ── helpers ────────────────────────────────────────────────────────────────────


def _resolve_tools(
    tools: list[Tool | str],
    search_api_key: str = "",
) -> list[Tool]:
    """Resolve a mix of Tool instances and shorthand strings into Tool objects."""
    resolved: list[Tool] = []
    for item in tools:
        if isinstance(item, Tool):
            resolved.append(item)
        elif isinstance(item, str):
            cls = _BUILTIN_TOOLS.get(item)
            if cls is None:
                raise ValueError(
                    f"Unknown built-in tool: {item!r}. "
                    f"Available: {list(_BUILTIN_TOOLS)}"
                )
            if item == "web_search" and search_api_key:
                resolved.append(WebSearchTool(api_key=search_api_key))
            else:
                resolved.append(cls())
        else:
            raise TypeError(f"Expected Tool instance or str, got {type(item)}")
    return resolved
