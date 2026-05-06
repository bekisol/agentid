"""
Anthropic (Claude) provider adapter.

Uses the Messages API with native tool_use support.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

import httpx

from .base import LLMProvider, ProviderResponse, ToolCall

if TYPE_CHECKING:
    from ..tools.base import Tool

logger = logging.getLogger(__name__)

_API_URL = "https://api.anthropic.com/v1/messages"
_DEFAULT_MODEL = "claude-opus-4-5"


class AnthropicProvider(LLMProvider):
    """
    Anthropic Claude via the Messages API.

    Parameters
    ----------
    api_key : str
        Anthropic API key (sk-ant-…).
    model : str
        Model name. Default: "claude-opus-4-5".

    Example
    -------
        provider = AnthropicProvider(api_key="sk-ant-...")
        brain = AgentBrain(..., provider=provider)
    """

    def __init__(self, api_key: str, model: str = _DEFAULT_MODEL) -> None:
        self._api_key = api_key
        self._model = model

    @property
    def name(self) -> str:
        return "anthropic"

    # ── tool formatting ────────────────────────────────────────────────────────

    def format_tools(self, tools: list["Tool"]) -> list[dict]:
        return [
            {
                "name": t.name,
                "description": t.description,
                "input_schema": t.parameters,
            }
            for t in tools
        ]

    # ── message formatting ────────────────────────────────────────────────────

    def response_as_message(self, response: ProviderResponse) -> dict:
        """
        Anthropic assistant message: content is a list of text + tool_use blocks.
        """
        content: list[dict] = []
        if response.text:
            content.append({"type": "text", "text": response.text})
        for tc in response.tool_calls:
            content.append(
                {"type": "tool_use", "id": tc.id, "name": tc.name, "input": tc.arguments}
            )
        return {"role": "assistant", "content": content}

    def tool_results_as_message(
        self, results: list[tuple[str, str, str]]
    ) -> dict:
        """
        Anthropic tool results: user message with tool_result content blocks.
        """
        return {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": call_id, "content": result}
                for call_id, _name, result in results
            ],
        }

    # ── API call ───────────────────────────────────────────────────────────────

    async def complete(
        self,
        messages: list[dict],
        system: str,
        tools: list["Tool"],
        max_tokens: int = 2000,
    ) -> ProviderResponse:
        body: dict = {
            "model": self._model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": messages,
        }
        if tools:
            body["tools"] = self.format_tools(tools)

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                _API_URL,
                headers={
                    "x-api-key": self._api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json=body,
            )

        if not resp.is_success:
            raise RuntimeError(
                f"Anthropic {resp.status_code}: {resp.text[:300]}"
            )

        data = resp.json()
        stop_reason = data.get("stop_reason", "end_turn")
        tool_calls: list[ToolCall] = []
        text_parts: list[str] = []

        for block in data.get("content", []):
            if block.get("type") == "text":
                text_parts.append(block["text"])
            elif block.get("type") == "tool_use":
                tool_calls.append(
                    ToolCall(
                        id=block["id"],
                        name=block["name"],
                        arguments=block.get("input", {}),
                    )
                )

        return ProviderResponse(
            text="\n".join(text_parts) or None,
            tool_calls=tool_calls,
            stop_reason=stop_reason,
        )
