"""
Test 4 — JudgmentEngine (ReAct agentic loop)
============================================
What it does: the LLM researches with tools then outputs a structured
JSON decision: {should_act, reasoning, summary, actions[]}.

This uses a MOCK provider so no real API key is needed.
To test with a real LLM, swap MockProvider for AnthropicProvider/OpenAIProvider.

Run:
    python3 examples/04_judgment_engine.py

What you should see:
  - JudgmentResult with should_act=False (mock returns "all quiet")
  - The reasoning and summary fields populated
"""

import asyncio
import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from unittest.mock import AsyncMock, MagicMock
from agentid.brain.judgment.engine import JudgmentEngine
from agentid.brain.providers.base import ProviderResponse
from agentid.brain.tools import WebSearchTool, FetchURLTool


# ── Mock provider (no API key needed) ─────────────────────────────────────────
class MockProvider:
    name = "mock"

    def format_tools(self, tools):
        return []

    def response_as_message(self, resp):
        return {"role": "assistant", "content": resp.text}

    def tool_results_as_message(self, results):
        return {"role": "user", "content": str(results)}

    async def complete(self, messages, tools, system="", max_tokens=2048):
        # Simulate LLM deciding no action needed
        return ProviderResponse(
            text=json.dumps({
                "should_act": False,
                "reasoning": "Brent crude is trading at $82, within normal range. No OPEC news.",
                "summary": "Oil market stable. No action needed.",
                "actions": [],
            })
        )


# ── To test with a REAL LLM, replace MockProvider with: ───────────────────────
# from agentid.brain.providers import AnthropicProvider
# provider = AnthropicProvider(api_key="sk-ant-YOUR_KEY_HERE")
#
# from agentid.brain.providers import OpenAIProvider
# provider = OpenAIProvider(api_key="sk-YOUR_KEY_HERE")


async def main():
    provider = MockProvider()
    tools = [WebSearchTool(), FetchURLTool()]

    engine = JudgmentEngine(provider=provider, tools=tools)

    print("Running judgment cycle...")
    print("Mission: Monitor oil markets. Alert if Brent crude moves >3%.\n")

    result = await engine.judge(
        mission="Monitor oil markets. Alert the portfolio manager if Brent crude moves >3%.",
        perceptions=[],
        context="Last check: Brent was $80. No OPEC announcements.",
    )

    print(f"should_act : {result.should_act}")
    print(f"reasoning  : {result.reasoning}")
    print(f"summary    : {result.summary}")
    print(f"actions    : {result.raw_actions}")


asyncio.run(main())
