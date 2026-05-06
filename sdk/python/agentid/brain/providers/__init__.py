"""
LLM provider adapters for AgentBrain.

Pick one and pass it to AgentBrain:

    from agentid.brain.providers import AnthropicProvider, OpenAIProvider, GeminiProvider

    # Claude
    provider = AnthropicProvider(api_key="sk-ant-...")

    # GPT-4o
    provider = OpenAIProvider(api_key="sk-...")

    # Grok (xAI)
    provider = OpenAIProvider(api_key="xai-...", base_url="https://api.x.ai/v1", model="grok-3")

    # Gemini
    provider = GeminiProvider(api_key="AIza...")

    # Mistral
    provider = OpenAIProvider(api_key="...", base_url="https://api.mistral.ai/v1",
                               model="mistral-large-latest")

    # Ollama (local, free)
    provider = OpenAIProvider(api_key="ollama", base_url="http://localhost:11434/v1",
                               model="llama3.2")

    # Groq (ultra-fast)
    provider = OpenAIProvider(api_key="gsk_...", base_url="https://api.groq.com/openai/v1",
                               model="llama-3.3-70b-versatile")
"""

from .base import LLMProvider, ProviderResponse, ToolCall
from .anthropic import AnthropicProvider
from .openai import OpenAIProvider
from .gemini import GeminiProvider

__all__ = [
    "LLMProvider",
    "ProviderResponse",
    "ToolCall",
    "AnthropicProvider",
    "OpenAIProvider",
    "GeminiProvider",
]
