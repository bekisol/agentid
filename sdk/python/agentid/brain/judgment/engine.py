"""
JudgmentEngine — provider-agnostic LLM decision making with tool use.

The engine runs an agentic research loop:

  1. Send mission + observations + memory context to the LLM
  2. LLM calls tools (web_search, fetch_url, custom) to research further
  3. Tool results are returned to the LLM
  4. Steps 2–3 repeat until the LLM stops calling tools
  5. LLM outputs a final JSON judgment
  6. Engine parses and returns a JudgmentResult

This means the brain can handle any domain — oil markets, code security,
competitor monitoring, earnings reports — without pre-built connectors.
The LLM researches whatever the mission requires.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Optional

from ..providers.base import LLMProvider
from ..perception.base import PerceptionData
from ..tools.base import Tool

logger = logging.getLogger(__name__)


# ── System prompt ──────────────────────────────────────────────────────────────

_SYSTEM_PROMPT = """\
You are the autonomous judgment engine for an AI agent.

Your process:
1. Read the agent's mission and current observations carefully.
2. Use your tools (web_search, fetch_url, etc.) to research anything needing \
   current context — prices, news, events, verification.
3. Decide whether action is required based on what you found.
4. Output your final decision as a single JSON object.

Decision rules:
- Only act when genuinely important. Do not act on trivial or unchanged data.
- For security issues (exposed credentials, injection, open ports) — always act.
- For market-moving events — verify the magnitude before acting.
- For strategic concerns — act only when there is concrete evidence of impact.
- When in doubt, search for more information before deciding.

After finishing your research, respond with ONLY this JSON (no other text):
{
  "should_act": <true|false>,
  "reasoning": "<1-3 sentence explanation>",
  "summary": "<one-line situation summary>",
  "actions": [
    {"type": "send_message",     "to_did": "<did>",        "body": "<message>"},
    {"type": "find_and_contact", "capability": "<tag>",    "body": "<message>", "max_agents": 3},
    {"type": "alert_owner",      "body": "<alert text>"},
    {"type": "store_note",       "key": "<key>",           "value": "<value>"}
  ]
}
"""

_FORCE_ANSWER_MSG = (
    "You have used the maximum number of research rounds. "
    "Based on everything gathered so far, output your JSON judgment now. "
    "No more tool calls — final JSON only."
)


# ── Data types ─────────────────────────────────────────────────────────────────


@dataclass
class JudgmentResult:
    """The output of one judgment cycle."""
    should_act: bool
    reasoning: str
    summary: str
    raw_actions: list[dict] = field(default_factory=list)
    error: Optional[str] = None


# ── Engine ─────────────────────────────────────────────────────────────────────


class JudgmentEngine:
    """
    Provider-agnostic LLM judgment engine with tool-use support.

    Works with any provider: Anthropic, OpenAI, Gemini, Grok, Mistral,
    Ollama, Groq, Together — swap providers without changing any other code.

    Parameters
    ----------
    provider : LLMProvider
        The AI provider to use for reasoning.
    tools : list[Tool]
        Tools available to the LLM for research (web_search, fetch_url, custom).
        The LLM decides when and how to call them based on the mission.
    max_rounds : int
        Maximum tool-use rounds per judgment cycle. Prevents runaway loops.
        Default: 8.
    max_tokens : int
        Maximum tokens per LLM response. Default: 2000.

    Example
    -------
        from agentid.brain.providers import AnthropicProvider
        from agentid.brain.tools import WebSearchTool, FetchURLTool

        engine = JudgmentEngine(
            provider=AnthropicProvider(api_key="sk-ant-..."),
            tools=[WebSearchTool(api_key="BSA..."), FetchURLTool()],
        )
        result = await engine.judge(mission, perceptions)
    """

    def __init__(
        self,
        provider: LLMProvider,
        tools: list[Tool] | None = None,
        max_rounds: int = 8,
        max_tokens: int = 2000,
    ) -> None:
        self._provider = provider
        self._tools: list[Tool] = tools or []
        self._registry: dict[str, Tool] = {t.name: t for t in self._tools}
        self._max_rounds = max_rounds
        self._max_tokens = max_tokens

    # ── Public API ─────────────────────────────────────────────────────────────

    def add_tool(self, tool: Tool) -> None:
        """
        Register an additional tool at runtime.

        Used by AgentBrain.add_mcp_server() to inject MCP tools after
        the engine is created. Safe to call before or during run().
        """
        if not any(t.name == tool.name for t in self._tools):
            self._tools.append(tool)
        self._registry[tool.name] = tool
        logger.debug("[brain/engine] tool registered: %s", tool.name)

    async def judge(
        self,
        mission: str,
        perceptions: list[PerceptionData],
        context: str = "",
    ) -> JudgmentResult:
        """
        Run the full agentic judgment loop.

        The LLM researches using tools, then outputs a structured decision.
        Returns a JudgmentResult with should_act, reasoning, and actions.
        """
        prompt = _build_prompt(mission, perceptions, context)
        messages: list[dict] = [{"role": "user", "content": prompt}]

        for round_num in range(self._max_rounds):
            try:
                response = await self._provider.complete(
                    messages=messages,
                    system=_SYSTEM_PROMPT,
                    tools=self._tools,
                    max_tokens=self._max_tokens,
                )
            except Exception as exc:
                logger.error(
                    "[brain/%s] round %d error: %s", self._provider.name, round_num, exc
                )
                return JudgmentResult(
                    should_act=False,
                    reasoning=f"Provider error: {exc}",
                    summary="Judgment unavailable",
                    error=str(exc),
                )

            # ── Tool calls → execute and loop ──────────────────────────────────
            if response.has_tool_calls():
                logger.info(
                    "[brain/%s] round %d — tools: %s",
                    self._provider.name,
                    round_num,
                    [tc.name for tc in response.tool_calls],
                )

                # Add assistant message with the tool calls
                messages.append(self._provider.response_as_message(response))

                # Execute every tool call
                results: list[tuple[str, str, str]] = []
                for tc in response.tool_calls:
                    tool = self._registry.get(tc.name)
                    if tool:
                        try:
                            result = await tool.run(**tc.arguments)
                            logger.debug(
                                "[brain/tool/%s] %s", tc.name, result[:200]
                            )
                        except Exception as exc:
                            result = f"Tool error: {exc}"
                            logger.warning("[brain/tool/%s] error: %s", tc.name, exc)
                    else:
                        result = f"Unknown tool: {tc.name!r}"
                        logger.warning("[brain] unknown tool requested: %s", tc.name)

                    results.append((tc.id, tc.name, result))

                # Add tool results to conversation
                tool_msg = self._provider.tool_results_as_message(results)
                if isinstance(tool_msg, list):
                    messages.extend(tool_msg)
                else:
                    messages.append(tool_msg)

                continue  # LLM reads results, may call more tools or output judgment

            # ── Final answer ───────────────────────────────────────────────────
            if response.text:
                logger.info(
                    "[brain/%s] judgment after %d round(s)",
                    self._provider.name,
                    round_num + 1,
                )
                return self._parse(response.text)

            logger.warning(
                "[brain/%s] empty response at round %d", self._provider.name, round_num
            )
            break

        # ── Max rounds: force a final answer without tools ─────────────────────
        logger.warning(
            "[brain/%s] max rounds (%d) reached — forcing answer",
            self._provider.name,
            self._max_rounds,
        )
        messages.append({"role": "user", "content": _FORCE_ANSWER_MSG})
        try:
            final = await self._provider.complete(
                messages=messages,
                system=_SYSTEM_PROMPT,
                tools=[],  # no tools — must output JSON
                max_tokens=self._max_tokens,
            )
            if final.text:
                return self._parse(final.text)
        except Exception as exc:
            logger.error("[brain/%s] forced-answer error: %s", self._provider.name, exc)

        return JudgmentResult(
            should_act=False,
            reasoning="Research limit reached without a conclusion.",
            summary="Judgment timeout",
            error="max_rounds_exceeded",
        )

    # ── Internal ───────────────────────────────────────────────────────────────

    def _parse(self, text: str) -> JudgmentResult:
        try:
            raw = _extract_json(text)
            return JudgmentResult(
                should_act=bool(raw.get("should_act", False)),
                reasoning=str(raw.get("reasoning", "")),
                summary=str(raw.get("summary", "")),
                raw_actions=raw.get("actions", []),
            )
        except (json.JSONDecodeError, KeyError, ValueError) as exc:
            logger.error(
                "[brain] parse error: %s\nRaw text: %s", exc, text[:400]
            )
            return JudgmentResult(
                should_act=False,
                reasoning="Could not parse LLM response as JSON.",
                summary="Parse error",
                error=str(exc),
            )


# ── Helpers ────────────────────────────────────────────────────────────────────


def _build_prompt(
    mission: str,
    perceptions: list[PerceptionData],
    memory_context: str,
) -> str:
    sections = [
        f"=== AGENT MISSION ===\n{mission}",
        f"=== MEMORY / HISTORY ===\n{memory_context}",
        "=== CURRENT OBSERVATIONS ===",
    ]
    for p in perceptions:
        sections.append(str(p))

    if not perceptions:
        sections.append("(No structured observations — use tools to research.)")

    sections.append(
        "\nResearch with your tools as needed, then output your JSON judgment."
    )
    return "\n\n".join(sections)


def _extract_json(text: str) -> dict:
    """Extract a JSON object from LLM output, handling markdown code fences."""
    text = text.strip()
    # Strip markdown fences
    if text.startswith("```"):
        lines = text.splitlines()
        text = "\n".join(ln for ln in lines if not ln.startswith("```")).strip()
    # Find outermost { ... }
    start = text.find("{")
    end = text.rfind("}") + 1
    if start != -1 and end > start:
        text = text[start:end]
    return json.loads(text)
