"""
OpenAI-compatible provider adapter.

A single class covers every OpenAI-compatible endpoint:

    Provider   | api_key        | base_url                        | model
    -----------|----------------|---------------------------------|------------------
    OpenAI     | sk-...         | (default)                       | gpt-5
    Grok (xAI) | xai-...        | https://api.x.ai/v1             | grok-3
    Mistral    | ...            | https://api.mistral.ai/v1       | mistral-large-latest
    Ollama     | ollama         | http://localhost:11434/v1       | llama3.2
    Together   | ...            | https://api.together.xyz/v1     | meta-llama/...
    Groq       | gsk_...        | https://api.groq.com/openai/v1  | llama-3.3-70b-versatile
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import TYPE_CHECKING

import httpx

from .base import LLMProvider, ProviderResponse, ToolCall

if TYPE_CHECKING:
    from ..tools.base import Tool

logger = logging.getLogger(__name__)

_DEFAULT_BASE_URL = "https://api.openai.com/v1"
_DEFAULT_MODEL = "gpt-5"


class OpenAIProvider(LLMProvider):
    """
    OpenAI Chat Completions API — and any compatible endpoint.

    Parameters
    ----------
    api_key : str
        API key. Use "ollama" for local Ollama.
    model : str
        Model name. Default: "gpt-5".
    base_url : str
        Override to point at Grok, Mistral, Ollama, Groq, Together, etc.

    Examples
    --------
        # OpenAI
        OpenAIProvider(api_key="sk-...")

        # Grok
        OpenAIProvider(api_key="xai-...", base_url="https://api.x.ai/v1", model="grok-3")

        # Mistral
        OpenAIProvider(api_key="...", base_url="https://api.mistral.ai/v1",
                       model="mistral-large-latest")

        # Ollama (local, free)
        OpenAIProvider(api_key="ollama", base_url="http://localhost:11434/v1",
                       model="llama3.2")

        # Groq (ultra-fast inference)
        OpenAIProvider(api_key="gsk_...", base_url="https://api.groq.com/openai/v1",
                       model="llama-3.3-70b-versatile")
    """

    def __init__(
        self,
        api_key: str,
        model: str = _DEFAULT_MODEL,
        base_url: str = _DEFAULT_BASE_URL,
    ) -> None:
        self._api_key = api_key
        self._model = model
        self._base_url = base_url.rstrip("/")

    @property
    def name(self) -> str:
        url = self._base_url
        if "x.ai" in url:
            return "grok"
        if "mistral" in url:
            return "mistral"
        if "groq.com" in url:
            return "groq"
        if "together" in url:
            return "together"
        if "localhost" in url or "127.0.0.1" in url:
            return "ollama"
        return "openai"

    # ── tool formatting ────────────────────────────────────────────────────────

    def format_tools(self, tools: list["Tool"]) -> list[dict]:
        return [
            {
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                },
            }
            for t in tools
        ]

    # ── message formatting ────────────────────────────────────────────────────

    def response_as_message(self, response: ProviderResponse) -> dict:
        msg: dict = {"role": "assistant", "content": response.text or ""}
        if response.tool_calls:
            msg["tool_calls"] = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.name,
                        "arguments": json.dumps(tc.arguments),
                    },
                }
                for tc in response.tool_calls
            ]
        return msg

    def tool_results_as_message(
        self, results: list[tuple[str, str, str]]
    ) -> list[dict]:
        """
        OpenAI requires one message per tool result (role="tool").
        Returns a list — the engine extends the message list with it.
        """
        return [
            {"role": "tool", "tool_call_id": call_id, "content": result}
            for call_id, _name, result in results
        ]

    # ── API call ───────────────────────────────────────────────────────────────

    async def complete(
        self,
        messages: list[dict],
        system: str,
        tools: list["Tool"],
        max_tokens: int = 2000,
    ) -> ProviderResponse:
        all_messages = [{"role": "system", "content": system}] + messages

        body: dict = {
            "model": self._model,
            "max_tokens": max_tokens,
            "messages": all_messages,
        }
        if tools:
            body["tools"] = self.format_tools(tools)
            body["tool_choice"] = "auto"

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{self._base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self._api_key}",
                    "content-type": "application/json",
                },
                json=body,
            )

        if not resp.is_success:
            raise RuntimeError(
                f"{self.name} {resp.status_code}: {resp.text[:300]}"
            )

        data = resp.json()
        choice = data["choices"][0]
        message = choice["message"]
        finish_reason = choice.get("finish_reason", "stop")

        tool_calls: list[ToolCall] = []
        for tc in message.get("tool_calls") or []:
            try:
                args = json.loads(tc["function"]["arguments"])
            except (json.JSONDecodeError, KeyError):
                args = {}
            tool_calls.append(
                ToolCall(id=tc["id"], name=tc["function"]["name"], arguments=args)
            )

        return ProviderResponse(
            text=message.get("content"),
            tool_calls=tool_calls,
            stop_reason=finish_reason,
        )
