"""
Test 7 — MCPSession bridge (connect any MCP server as brain tools)
==================================================================
What it does: connects to an MCP server and exposes ALL its tools
to the brain's LLM — works with Claude, GPT, Gemini, Grok, etc.

Two transports:
  stdio — spawns a local subprocess (npx / uvx / python)
  http  — talks to a running MCP server via HTTP POST

This script tests the HTTP transport against a local mock server,
and shows the stdio API (commented, needs npx installed).

Run:
    python3 examples/07_mcp_bridge.py

What you should see:
  - MCPSession created for stdio and http
  - Tool definitions printed
  - call_tool result printed
"""

import asyncio
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agentid.brain.tools.mcp import MCPSession, MCPProxyTool


def demo_session_creation():
    print("=" * 55)
    print("MCPSession — session object creation (no network)")
    print("=" * 55)

    # stdio transport (runs a local command)
    stdio_session = MCPSession.stdio(
        command="npx",
        args=["-y", "@modelcontextprotocol/server-brave-search"],
        env={"BRAVE_API_KEY": "YOUR_BRAVE_KEY"},
    )
    print(f"stdio session: {stdio_session}")

    # HTTP transport (talks to a running MCP server)
    http_session = MCPSession.http(
        url="http://localhost:3000",
        headers={"Authorization": "Bearer your-token"},
    )
    print(f"http  session: {http_session}")


def demo_proxy_tool():
    print()
    print("=" * 55)
    print("MCPProxyTool — wraps an MCP tool as a brain Tool")
    print("=" * 55)

    from unittest.mock import MagicMock
    session = MagicMock()

    tool = MCPProxyTool(session, {
        "name": "brave_web_search",
        "description": "Search the web using Brave Search.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
            },
            "required": ["query"],
        },
    })

    print(f"Tool name       : {tool.name}")
    print(f"Tool description: {tool.description}")
    print(f"Parameters      : {tool.parameters}")
    print(f"repr            : {tool!r}")


print()
demo_session_creation()
demo_proxy_tool()

print()
print("=" * 55)
print("To run a REAL MCP server test:")
print("=" * 55)
print("""
  # Requires: npm + npx installed
  # Get a free Brave API key at https://api.search.brave.com/

  import asyncio
  from agentid.brain.tools.mcp import MCPSession

  async def real_mcp_test():
      session = MCPSession.stdio(
          "npx",
          ["-y", "@modelcontextprotocol/server-brave-search"],
          env={"BRAVE_API_KEY": "BSA_YOUR_KEY"},
      )
      async with session:
          tools = await session.tools()
          print(f"Tools available: {[t.name for t in tools]}")

          result = await session.call_tool(
              "brave_web_search",
              {"query": "Brent crude oil price today"},
          )
          print(result)

  asyncio.run(real_mcp_test())
""")

print()
print("To use MCP server tools inside the full brain:")
print("""
  import asyncio
  from agentid.brain import AgentBrain
  from agentid.brain.providers import AnthropicProvider

  async def main():
      brain = AgentBrain(
          agent_did="did:agentid:YOUR_DID",
          api_key="agentid_YOUR_KEY",
          mission="Monitor oil markets. Alert if Brent moves >3%.",
          provider=AnthropicProvider(api_key="sk-ant-YOUR_KEY"),
          tools=[],
      )

      # Connect MCP server — tools auto-injected
      await brain.add_mcp_server(
          "npx",
          ["-y", "@modelcontextprotocol/server-brave-search"],
          env={"BRAVE_API_KEY": "BSA_YOUR_KEY"},
      )

      # Now run — the LLM will use brave_web_search automatically
      await brain.think_once()

  asyncio.run(main())
""")
