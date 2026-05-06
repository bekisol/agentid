"""
Test 6 — Full AgentBrain (one cycle, no loop)
=============================================
What it does: runs a complete think cycle:
  perception → judgment → (would execute actions)

Uses think_once() instead of run() so it fires once and exits.
Uses a mock provider — no real API key needed.

To test with a REAL LLM + REAL search, see the commented section at bottom.

Run:
    python3 examples/06_full_brain.py

What you should see:
  - Brain initialises with mock provider
  - think_once() runs: reads perceptions, calls judgment, gets result
  - Prints: should_act=False, summary="All quiet"
"""

import asyncio
import json
import sys
import os
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Patch BrainMemory to use tmp dir so it doesn't write to real agent storage
from pathlib import Path
import agentid.brain.memory.store as _mem_store
_TMP = tempfile.mkdtemp()
_mem_store.BRAIN_DIR = Path(_TMP) / "brain"

from agentid.brain import AgentBrain
from agentid.brain.providers.base import LLMProvider, ProviderResponse
from agentid.brain.perception.files import FilePerception
from agentid.brain.triggers import IntervalTrigger


class MockProvider(LLMProvider):
    name = "mock"

    def format_tools(self, tools):
        return []

    def response_as_message(self, resp):
        return {"role": "assistant", "content": resp.text}

    def tool_results_as_message(self, results):
        return {"role": "user", "content": str(results)}

    async def complete(self, messages, tools, system="", max_tokens=2048):
        return ProviderResponse(
            text=json.dumps({
                "should_act": False,
                "reasoning": "No significant oil market change detected today.",
                "summary": "Market stable. Brent ~$82. No OPEC news.",
                "actions": [],
            })
        )


async def main():
    # Create a file for the brain to watch
    with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
        f.write("Brent crude: $82.15\nNo OPEC announcements.\n")
        watch_file = f.name

    brain = AgentBrain(
        agent_did="did:agentid:test-oil-monitor",
        api_key="agentid_test",
        mission=(
            "Monitor Brent crude oil prices. "
            "Alert the portfolio manager if price moves more than 3% "
            "or OPEC makes a surprise announcement."
        ),
        provider=MockProvider(),
        tools=[],  # empty — mock provider doesn't need real tools
    )

    # Add a file perception source
    brain.add_perception(FilePerception(watch_file, name="market-data"))

    print(f"Brain: {brain}")
    print("\nRunning one think cycle (think_once)...\n")

    await brain.think_once()

    print("Cycle complete.")
    print(f"Memory context:\n{brain.memory.get_context()}")

    os.unlink(watch_file)


asyncio.run(main())


# ── REAL test with actual LLM + search ────────────────────────────────────────
# Uncomment this block to run a real cycle with Claude + Brave Search.
#
# import asyncio
# from agentid.brain import AgentBrain
# from agentid.brain.providers import AnthropicProvider
# from agentid.brain.tools import WebSearchTool, FetchURLTool
#
# async def real_test():
#     brain = AgentBrain(
#         agent_did="did:agentid:YOUR_DID",
#         api_key="agentid_YOUR_KEY",
#         mission=(
#             "Monitor Brent crude oil prices and OPEC news. "
#             "Alert the portfolio manager if price moves more than 3% "
#             "or OPEC makes a surprise announcement."
#         ),
#         provider=AnthropicProvider(api_key="sk-ant-YOUR_CLAUDE_KEY"),
#         tools=[
#             WebSearchTool(),              # DuckDuckGo (free, no key)
#             FetchURLTool(),
#         ],
#     )
#     brain.memory.set_note("owner_did", "did:agentid:PORTFOLIO_MANAGER_DID")
#     await brain.think_once()
#
# asyncio.run(real_test())
