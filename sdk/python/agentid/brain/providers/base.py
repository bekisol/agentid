"""
LLMProvider — abstract base for all AI model adapters.

Every provider (Anthropic, OpenAI, Gemini, Grok, Mistral, Ollama, …)
implements this interface. The JudgmentEngine is 100% provider-agnostic.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..tools.base import Tool


@dataclass
class ToolCall:
    """A single tool / function call requested by the LLM."""
    id: str
    name: str
    arguments: dict


@dataclass
class ProviderResponse:
    """Unified response from any LLM provider."""
    text: str | None
    tool_calls: list[ToolCall] = field(default_factory=list)
    stop_reason: str = "end_turn"

    def has_tool_calls(self) -> bool:
        return bool(self.tool_calls)


class LLMProvider(ABC):
    """
    Abstract base for LLM provider adapters.

    Implement this to add any AI model. The judgment engine calls only
    these five methods — no provider-specific code leaks into the brain.
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Short human-readable name (e.g. 'anthropic', 'openai', 'gemini')."""
        ...

    @abstractmethod
    def format_tools(self, tools: list["Tool"]) -> list[dict]:
        """
        Convert Tool objects into the provider's native tool/function spec.
        Returns a list ready to drop into the API request body.
        """
        ...

    @abstractmethod
    def response_as_message(self, response: ProviderResponse) -> dict:
        """
        Convert a ProviderResponse (containing tool_calls) into an assistant
        message dict for the next API call in the conversation.
        """
        ...

    @abstractmethod
    def tool_results_as_message(
        self, results: list[tuple[str, str, str]]
    ) -> dict | list[dict]:
        """
        Wrap executed tool results into the next message(s).

        Parameters
        ----------
        results : list of (call_id, tool_name, result_text)

        Returns a single dict OR a list of dicts (OpenAI needs one per result).
        """
        ...

    @abstractmethod
    async def complete(
        self,
        messages: list[dict],
        system: str,
        tools: list["Tool"],
        max_tokens: int = 2000,
    ) -> ProviderResponse:
        """
        Send messages to the LLM and return a unified ProviderResponse.

        Parameters
        ----------
        messages  : conversation history (provider-specific format managed internally)
        system    : system prompt
        tools     : Tool instances available this turn (empty = no tool use)
        max_tokens: maximum tokens in the response
        """
        ...
