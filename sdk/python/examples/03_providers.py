"""
Test 3 — Provider layer (Claude / GPT / Gemini / Grok / Ollama)
================================================================
What it does: shows how to swap AI providers with zero other code changes.
Each provider formats tool definitions and parses responses differently —
the abstraction hides all of that.

This script tests the provider FORMAT methods (no real API calls needed).
To test actual completions, uncomment the relevant section and add your key.

Run:
    python3 examples/03_providers.py

What you should see: formatted tool definitions for each provider,
confirming the abstraction works.
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agentid.brain.providers import AnthropicProvider, OpenAIProvider, GeminiProvider
from agentid.brain.tools import WebSearchTool

tool = WebSearchTool()

# ── Show how each provider formats the same tool differently ──────────────────

print("=" * 60)
print("ANTHROPIC format (input_schema)")
print("=" * 60)
p = AnthropicProvider(api_key="sk-ant-placeholder")
formatted = p.format_tools([tool])
import json
print(json.dumps(formatted[0], indent=2))

print()
print("=" * 60)
print("OPENAI / GROK / MISTRAL format (function calling)")
print("=" * 60)
p2 = OpenAIProvider(api_key="sk-placeholder")
formatted2 = p2.format_tools([tool])
print(json.dumps(formatted2[0], indent=2))

print()
print("=" * 60)
print("GEMINI format (functionDeclarations)")
print("=" * 60)
p3 = GeminiProvider(api_key="AIza-placeholder")
formatted3 = p3.format_tools([tool])
print(json.dumps(formatted3[0], indent=2))

print()
print("Provider names:")
print(f"  AnthropicProvider → {p.name}")
print(f"  OpenAIProvider    → {p2.name}")

# Grok uses same OpenAI class, different base_url
p_grok = OpenAIProvider(api_key="xai-placeholder", base_url="https://api.x.ai/v1", model="grok-3")
print(f"  OpenAIProvider (Grok base_url) → {p_grok.name}")

p_ollama = OpenAIProvider(api_key="ollama", base_url="http://localhost:11434/v1", model="llama3.2")
print(f"  OpenAIProvider (Ollama base_url) → {p_ollama.name}")
print(f"  GeminiProvider    → {p3.name}")

print()
print("All provider format tests passed.")

# ── To test a real completion, uncomment one block below ──────────────────────

# import asyncio
# from agentid.brain.providers.base import ProviderResponse
#
# ANTHROPIC_KEY = "sk-ant-YOUR_KEY"
# async def test_anthropic():
#     p = AnthropicProvider(api_key=ANTHROPIC_KEY)
#     messages = [{"role": "user", "content": "Say hello in one sentence."}]
#     resp = await p.complete(messages=messages, tools=[])
#     print("Anthropic:", resp.text)
# asyncio.run(test_anthropic())

# OPENAI_KEY = "sk-YOUR_KEY"
# async def test_openai():
#     p = OpenAIProvider(api_key=OPENAI_KEY)
#     messages = [{"role": "user", "content": "Say hello in one sentence."}]
#     resp = await p.complete(messages=messages, tools=[])
#     print("OpenAI:", resp.text)
# asyncio.run(test_openai())
