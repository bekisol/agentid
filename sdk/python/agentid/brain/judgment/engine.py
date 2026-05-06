"""
JudgmentEngine — LLM-powered decision making for AgentBrain.

Supports both OpenAI and Anthropic (following the rule: every integration
must support both providers).

The engine takes:
  - The agent's mission
  - Current perception data (what was observed)
  - Memory context (what was done before)

And returns a JudgmentResult:
  - should_act: bool
  - reasoning: why (or why not)
  - summary: one-line summary of the situation
  - actions: list of Action dicts to execute
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Optional

import httpx

from ..perception.base import PerceptionData

logger = logging.getLogger(__name__)


_JUDGMENT_SCHEMA = """
{
  "should_act": <true|false>,
  "reasoning": "<why you decided to act or not>",
  "summary": "<one-line situation summary>",
  "actions": [
    // Zero or more of:
    {"type": "send_message",     "to_did": "<did>",        "body": "<message text>"},
    {"type": "find_and_contact", "capability": "<tag>",    "body": "<message text>", "max_agents": 3},
    {"type": "alert_owner",      "body": "<alert text>"},
    {"type": "store_note",       "key": "<key>",           "value": "<value>"}
  ]
}
"""

_SYSTEM_PROMPT = """\
You are the autonomous judgment engine for an AI agent.
Your job is to observe data and decide whether action is required.

Rules:
1. Only act when genuinely important. Do not act on trivial or unchanged data.
2. When acting, be specific and concise in messages. Include file names, line numbers, etc.
3. For security issues (exposed credentials, SQL injection, open ports) — always act.
4. For strategic concerns — act if there is clear evidence of a problem.
5. Store notes about ongoing situations so you have context next time.

You must respond with ONLY a JSON object matching this schema:
""" + _JUDGMENT_SCHEMA


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

    sections.append(
        "\nBased on the above, decide whether action is needed and what to do.\n"
        "Respond ONLY with the JSON object."
    )
    return "\n\n".join(sections)


def _parse_response(text: str) -> dict:
    """Extract JSON from LLM response, even if wrapped in markdown fences."""
    text = text.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        text = "\n".join(
            l for l in lines if not l.startswith("```")
        ).strip()
    # Find first { and last }
    start = text.find("{")
    end = text.rfind("}") + 1
    if start != -1 and end > start:
        text = text[start:end]
    return json.loads(text)


@dataclass
class JudgmentResult:
    """The output of one judgment cycle."""
    should_act: bool
    reasoning: str
    summary: str
    raw_actions: list[dict] = field(default_factory=list)
    error: Optional[str] = None


class JudgmentEngine:
    """
    Calls an LLM to judge whether the agent should act and what to do.

    Tries Anthropic first if both keys are provided (Claude has stronger
    reasoning for security/strategic analysis). Falls back to OpenAI.

    Parameters
    ----------
    openai_key : str
        OpenAI API key (sk-...). Required if anthropic_key is not set.
    anthropic_key : str
        Anthropic API key (sk-ant-...). Required if openai_key is not set.
    openai_model : str
        OpenAI model to use. Default "gpt-4o".
    anthropic_model : str
        Anthropic model to use. Default "claude-3-5-sonnet-20241022".
    """

    def __init__(
        self,
        openai_key: str = "",
        anthropic_key: str = "",
        openai_model: str = "gpt-4o",
        anthropic_model: str = "claude-3-5-sonnet-20241022",
    ) -> None:
        if not openai_key and not anthropic_key:
            raise ValueError(
                "JudgmentEngine requires at least one of: openai_key, anthropic_key"
            )
        self._openai_key = openai_key
        self._anthropic_key = anthropic_key
        self._openai_model = openai_model
        self._anthropic_model = anthropic_model

    async def judge(
        self,
        mission: str,
        perceptions: list[PerceptionData],
        context: str = "",
    ) -> JudgmentResult:
        """
        Run the judgment cycle. Returns a JudgmentResult with actions.
        Tries Anthropic first, falls back to OpenAI on failure.
        """
        prompt = _build_prompt(mission, perceptions, context)

        # Try Anthropic first (better at nuanced analysis)
        if self._anthropic_key:
            result = await self._call_anthropic(prompt)
            if result and not result.error:
                return result
            logger.warning("[brain] Anthropic judgment failed, trying OpenAI")

        # Fallback to OpenAI
        if self._openai_key:
            result = await self._call_openai(prompt)
            if result:
                return result

        return JudgmentResult(
            should_act=False,
            reasoning="All LLM providers failed.",
            summary="Judgment unavailable",
            error="All providers failed",
        )

    async def _call_anthropic(self, prompt: str) -> Optional[JudgmentResult]:
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.post(
                    "https://api.anthropic.com/v1/messages",
                    headers={
                        "x-api-key": self._anthropic_key,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json",
                    },
                    json={
                        "model": self._anthropic_model,
                        "max_tokens": 1500,
                        "system": _SYSTEM_PROMPT,
                        "messages": [{"role": "user", "content": prompt}],
                    },
                )
            if not resp.is_success:
                logger.error("[brain] Anthropic API error %d: %s", resp.status_code, resp.text[:200])
                return None
            data = resp.json()
            text = next(
                (b["text"] for b in data.get("content", []) if b.get("type") == "text"),
                "",
            )
            return self._parse(text, provider="anthropic")
        except Exception as exc:
            logger.error("[brain] Anthropic call error: %s", exc)
            return None

    async def _call_openai(self, prompt: str) -> Optional[JudgmentResult]:
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self._openai_key}",
                        "content-type": "application/json",
                    },
                    json={
                        "model": self._openai_model,
                        "max_tokens": 1500,
                        "response_format": {"type": "json_object"},
                        "messages": [
                            {"role": "system", "content": _SYSTEM_PROMPT},
                            {"role": "user", "content": prompt},
                        ],
                    },
                )
            if not resp.is_success:
                logger.error("[brain] OpenAI API error %d: %s", resp.status_code, resp.text[:200])
                return None
            data = resp.json()
            text = data["choices"][0]["message"]["content"]
            return self._parse(text, provider="openai")
        except Exception as exc:
            logger.error("[brain] OpenAI call error: %s", exc)
            return None

    def _parse(self, text: str, provider: str) -> JudgmentResult:
        try:
            raw = _parse_response(text)
            return JudgmentResult(
                should_act=bool(raw.get("should_act", False)),
                reasoning=str(raw.get("reasoning", "")),
                summary=str(raw.get("summary", "")),
                raw_actions=raw.get("actions", []),
            )
        except (json.JSONDecodeError, KeyError) as exc:
            logger.error("[brain] %s response parse error: %s\nRaw: %s", provider, exc, text[:300])
            return JudgmentResult(
                should_act=False,
                reasoning="Could not parse LLM response.",
                summary="Parse error",
                error=str(exc),
            )
