"""
Google Gemini provider adapter.

Uses the Generative Language REST API directly — no google-generativeai SDK
dependency. Works with Gemini 1.5 Pro, Gemini 2.0 Flash, etc.
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

_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"
_DEFAULT_MODEL = "gemini-2.0-flash"


class GeminiProvider(LLMProvider):
    """
    Google Gemini via the Generative Language REST API.

    Parameters
    ----------
    api_key : str
        Google AI Studio API key (AIza…).
        Get one free at: https://aistudio.google.com/apikey
    model : str
        Model name. Default: "gemini-2.0-flash".
        Other options: "gemini-1.5-pro", "gemini-1.5-flash"

    Example
    -------
        provider = GeminiProvider(api_key="AIza...")
        brain = AgentBrain(..., provider=provider)
    """

    def __init__(self, api_key: str, model: str = _DEFAULT_MODEL) -> None:
        self._api_key = api_key
        self._model = model

    @property
    def name(self) -> str:
        return "gemini"

    # ── tool formatting ────────────────────────────────────────────────────────

    def format_tools(self, tools: list["Tool"]) -> list[dict]:
        """Gemini uses functionDeclarations nested inside a tools array."""
        return [
            {
                "functionDeclarations": [
                    {
                        "name": t.name,
                        "description": t.description,
                        "parameters": _to_gemini_schema(t.parameters),
                    }
                    for t in tools
                ]
            }
        ]

    # ── message formatting ────────────────────────────────────────────────────

    def response_as_message(self, response: ProviderResponse) -> dict:
        """Gemini model message: role='model', parts=[text | functionCall]."""
        parts: list[dict] = []
        if response.text:
            parts.append({"text": response.text})
        for tc in response.tool_calls:
            parts.append({"functionCall": {"name": tc.name, "args": tc.arguments}})
        return {"role": "model", "parts": parts}

    def tool_results_as_message(
        self, results: list[tuple[str, str, str]]
    ) -> dict:
        """Gemini tool results: role='user', parts=[functionResponse]."""
        return {
            "role": "user",
            "parts": [
                {
                    "functionResponse": {
                        "name": tool_name,
                        "response": {"result": result},
                    }
                }
                for _call_id, tool_name, result in results
            ],
        }

    # ── internal helpers ──────────────────────────────────────────────────────

    def _to_gemini_messages(self, messages: list[dict]) -> list[dict]:
        """
        Convert OpenAI-style messages to Gemini contents format.

        OpenAI roles: user, assistant, tool
        Gemini roles: user, model
        """
        out: list[dict] = []
        for msg in messages:
            role = msg["role"]

            if role == "user":
                content = msg.get("content", "")
                if isinstance(content, str):
                    out.append({"role": "user", "parts": [{"text": content}]})
                else:
                    # Already in Gemini format (tool results produced by tool_results_as_message)
                    out.append(msg)

            elif role == "assistant":
                parts: list[dict] = []
                if msg.get("content"):
                    parts.append({"text": msg["content"]})
                for tc in msg.get("tool_calls", []):
                    try:
                        args = json.loads(tc["function"]["arguments"])
                    except (json.JSONDecodeError, KeyError):
                        args = {}
                    parts.append(
                        {"functionCall": {"name": tc["function"]["name"], "args": args}}
                    )
                out.append({"role": "model", "parts": parts or [{"text": ""}]})

            elif role == "model":
                # Already in Gemini format
                out.append(msg)

            # "tool" role messages from OpenAI format are handled as user messages
            # by tool_results_as_message returning Gemini-native dicts

        return out

    # ── API call ───────────────────────────────────────────────────────────────

    async def complete(
        self,
        messages: list[dict],
        system: str,
        tools: list["Tool"],
        max_tokens: int = 2000,
    ) -> ProviderResponse:
        url = f"{_BASE_URL}/{self._model}:generateContent"

        body: dict = {
            "contents": self._to_gemini_messages(messages),
            "systemInstruction": {"parts": [{"text": system}]},
            "generationConfig": {"maxOutputTokens": max_tokens},
        }
        if tools:
            body["tools"] = self.format_tools(tools)

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                url,
                params={"key": self._api_key},
                headers={"content-type": "application/json"},
                json=body,
            )

        if not resp.is_success:
            raise RuntimeError(
                f"Gemini {resp.status_code}: {resp.text[:300]}"
            )

        data = resp.json()

        try:
            candidate = data["candidates"][0]
            parts = candidate["content"]["parts"]
            finish_reason = candidate.get("finishReason", "STOP")
        except (KeyError, IndexError) as exc:
            raise RuntimeError(f"Unexpected Gemini response shape: {data}") from exc

        tool_calls: list[ToolCall] = []
        text_parts: list[str] = []

        for part in parts:
            if "text" in part:
                text_parts.append(part["text"])
            elif "functionCall" in part:
                fc = part["functionCall"]
                tool_calls.append(
                    ToolCall(
                        id=str(uuid.uuid4()),  # Gemini has no call IDs
                        name=fc["name"],
                        arguments=fc.get("args", {}),
                    )
                )

        return ProviderResponse(
            text="\n".join(text_parts) or None,
            tool_calls=tool_calls,
            stop_reason=finish_reason,
        )


# ── schema conversion ──────────────────────────────────────────────────────────


def _to_gemini_schema(schema: dict) -> dict:
    """
    Convert JSON Schema (OpenAI-style) to Gemini's parameter schema.
    Gemini uses UPPER_CASE type names (OBJECT, STRING, INTEGER, …).
    """
    TYPE_MAP = {
        "object": "OBJECT",
        "string": "STRING",
        "integer": "INTEGER",
        "number": "NUMBER",
        "boolean": "BOOLEAN",
        "array": "ARRAY",
    }
    result: dict = {}

    if "type" in schema:
        result["type"] = TYPE_MAP.get(schema["type"], schema["type"].upper())
    if "description" in schema:
        result["description"] = schema["description"]
    if "properties" in schema:
        result["properties"] = {
            k: _to_gemini_schema(v) for k, v in schema["properties"].items()
        }
    if "required" in schema:
        result["required"] = schema["required"]
    if "items" in schema:
        result["items"] = _to_gemini_schema(schema["items"])
    if "enum" in schema:
        result["enum"] = schema["enum"]

    return result
