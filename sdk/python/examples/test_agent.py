"""
AgentID Brain — Live Test Agent
================================
A real deployable agent that wires together:
  • AgentRuntime  (receives messages from the AgentID platform)
  • JudgmentEngine (ReAct loop: research with tools → decide)
  • WebSearchTool + FetchURLTool (real web access)
  • BrainMemory  (persistent notes across messages)
  • FilePerception + APIPerception (change detection)

Setup
-----
1. Copy and fill in your keys below (or set as env vars):
     AGENTID_DID      — your agent's DID (e.g. did:agentid:abc123)
     AGENTID_API_KEY  — your AgentID API key (agentid_...)
     CLAUDE_API_KEY   — Anthropic key  (sk-ant-...)  ← recommended
       OR
     OPENAI_API_KEY   — OpenAI key     (sk-...)
     BRAVE_API_KEY    — Brave Search   (BSA-...)      ← optional, improves search

2. Run:
     cd /Users/bereket/Documents/agentid/sdk/python
     python3 examples/test_agent.py

3. Send messages to the agent from the AgentID platform or another agent.
   See the "Commands" section below for what to say.

Commands understood
-------------------
  search: <query>         → WebSearchTool live search
  fetch: <url>            → FetchURLTool reads the page
  remember: <key>=<value> → stores a note in BrainMemory
  recall                  → prints everything in memory
  watch: <filepath>       → FilePerception — reports if file changed
  check: <url>            → APIPerception — reports if endpoint changed
  think: <topic>          → full ReAct judgment cycle on that topic
  status                  → shows brain config and memory summary
  <anything else>         → full judgment cycle using your message as context
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agentid.runtime import AgentRuntime
from agentid.brain.judgment.engine import JudgmentEngine
from agentid.brain.memory.store import BrainMemory
from agentid.brain.tools import WebSearchTool, FetchURLTool
from agentid.brain.perception.files import FilePerception
from agentid.brain.perception.api import APIPerception

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(name)s  %(message)s")
logger = logging.getLogger("test-agent")

# ── Keys — fill in here or set as environment variables ───────────────────────
AGENT_DID     = os.getenv("AGENTID_DID",     "YOUR_AGENT_DID_HERE")
AGENTID_KEY   = os.getenv("AGENTID_API_KEY", "YOUR_AGENTID_KEY_HERE")
CLAUDE_KEY    = os.getenv("CLAUDE_API_KEY",  "")
OPENAI_KEY    = os.getenv("OPENAI_API_KEY",  "")

BASE_URL      = "https://api.agentid-protocol.com"

# Tavily Search MCP — served by agentid-pro, no per-user key needed
SEARCH_MCP_URL = f"{BASE_URL}/api/search"

# ── Pick provider ─────────────────────────────────────────────────────────────
def _build_provider():
    global _provider
    if CLAUDE_KEY and not CLAUDE_KEY.startswith("YOUR"):
        from agentid.brain.providers import AnthropicProvider
        logger.info("Provider: Claude (Anthropic)")
        _provider = AnthropicProvider(api_key=CLAUDE_KEY)
    elif OPENAI_KEY and not OPENAI_KEY.startswith("YOUR"):
        from agentid.brain.providers import OpenAIProvider
        logger.info("Provider: GPT-4o (OpenAI)")
        _provider = OpenAIProvider(api_key=OPENAI_KEY)
    else:
        raise RuntimeError(
            "No provider key found. Set CLAUDE_API_KEY or OPENAI_API_KEY."
        )
    return _provider

# ── Build tools ───────────────────────────────────────────────────────────────
_mcp_session = None  # persistent MCPSession to Brave Search MCP service

async def _get_mcp_tools() -> list:
    """Connect to the Tavily Search MCP service (once) and return its tools."""
    global _mcp_session
    from agentid.brain.tools.mcp import MCPSession
    if _mcp_session is None:
        _mcp_session = MCPSession.http(
            SEARCH_MCP_URL,
            headers={"Authorization": f"Bearer {AGENTID_KEY}"},
        )
        try:
            await _mcp_session.connect()
            logger.info("Search: Tavily Search MCP (%s)", SEARCH_MCP_URL)
        except Exception as exc:
            logger.warning("Brave MCP unavailable (%s) — falling back to DuckDuckGo", exc)
            _mcp_session = None
            return [WebSearchTool()]
    return await _mcp_session.tools()

def _build_tools():
    """Sync tool list for startup display — MCP tools added async at first request."""
    return [FetchURLTool(), WebSearchTool()]  # WebSearchTool shown until MCP connects

# ── Shared state ──────────────────────────────────────────────────────────────
_provider = None
_tools    = None
_engine   = None
_memory   = None

# Per-URL/file state tokens for perception tests
_perception_states: dict[str, str] = {}


def _get_engine() -> JudgmentEngine:
    global _provider, _tools, _engine
    if _engine is None:
        _provider = _build_provider()
        _tools    = _build_tools()
        _engine   = JudgmentEngine(provider=_provider, tools=_tools)
    return _engine


def _get_memory() -> BrainMemory:
    global _memory
    if _memory is None:
        _memory = BrainMemory(AGENT_DID)
    return _memory


# ── Command handlers ──────────────────────────────────────────────────────────

async def _cmd_search(query: str) -> str:
    """Tests: Brave Search via MCP service (or DuckDuckGo fallback)"""
    mcp_tools = await _get_mcp_tools()
    search_tool = next((t for t in mcp_tools if "search" in t.name), None)
    if not search_tool:
        search_tool = WebSearchTool()
    result = await search_tool.run(query=query)
    return f"[Tavily Search MCP] Query: '{query}'\n\n{result}"


async def _cmd_fetch(url: str) -> str:
    """Tests: FetchURLTool — fetches and strips the page"""
    tool = FetchURLTool()
    result = await tool.run(url=url)
    return f"[FetchURLTool] URL: {url}\n\n{result[:1500]}"


def _cmd_remember(raw: str) -> str:
    """Tests: BrainMemory.set_note() — persistent key/value storage"""
    mem = _get_memory()
    if "=" not in raw:
        return "Format: remember: key=value"
    key, _, value = raw.partition("=")
    mem.set_note(key.strip(), value.strip())
    return f"[BrainMemory] Stored: {key.strip()} = {value.strip()}"


def _cmd_recall() -> str:
    """Tests: BrainMemory.get_context() — retrieve all stored state"""
    mem = _get_memory()
    ctx = mem.get_context()
    if not ctx or ctx == "No prior history.":
        return "[BrainMemory] Nothing stored yet. Try: remember: owner=John"
    return f"[BrainMemory] Current memory:\n\n{ctx}"


async def _cmd_watch(filepath: str) -> str:
    """Tests: FilePerception — SHA-256 change detection on a file"""
    perception = FilePerception(filepath, name=f"watch:{filepath}")
    last = _perception_states.get(filepath)
    data = await perception.read(last_state=last)
    _perception_states[filepath] = data.state_token

    status = "CHANGED" if data.changed else ("UNCHANGED" if last else "FIRST READ")
    return (
        f"[FilePerception] {filepath}\n"
        f"Status    : {status}\n"
        f"State token: {data.state_token[:16]}...\n\n"
        f"Content preview:\n{data.content[:400]}"
    )


async def _cmd_check(url: str) -> str:
    """Tests: APIPerception — HTTP endpoint change detection"""
    perception = APIPerception(url=url, name=f"check:{url}")
    last = _perception_states.get(url)
    data = await perception.read(last_state=last)
    _perception_states[url] = data.state_token

    status = "CHANGED" if data.changed else ("UNCHANGED" if last else "FIRST READ")
    return (
        f"[APIPerception] {url}\n"
        f"Status    : {status}\n"
        f"State token: {data.state_token[:16]}...\n"
        f"Source    : {data.source}"
    )


async def _cmd_think(topic: str) -> str:
    """Tests: full JudgmentEngine ReAct loop (research → decide)"""
    engine = _get_engine()
    # Inject MCP tools into engine for this call
    mcp_tools = await _get_mcp_tools()
    for t in mcp_tools:
        engine.add_tool(t)
    mem    = _get_memory()
    result = await engine.judge(
        mission=f"Research this topic thoroughly and give a clear answer: {topic}",
        perceptions=[],
        context=mem.get_context(),
    )
    mem.record_action("think", topic[:100])
    return (
        f"[JudgmentEngine] Topic: {topic}\n\n"
        f"Should act : {result.should_act}\n"
        f"Reasoning  : {result.reasoning}\n\n"
        f"Summary    : {result.summary}"
    )


def _cmd_status() -> str:
    """Tests: AgentBrain repr / memory state / tool list"""
    tools = _build_tools()
    mem   = _get_memory()
    provider_name = "not initialised"
    if _provider:
        provider_name = _provider.name

    lines = [
        "[Test Agent Status]",
        f"Agent DID : {AGENT_DID}",
        f"Provider  : {provider_name}",
        f"Tools     : {[t.name for t in tools]}",
        f"Memory    : {mem._path if hasattr(mem, '_path') else 'active'}",
        "",
        "Memory context:",
        mem.get_context()[:300],
    ]
    return "\n".join(lines)


async def _cmd_full_judgment(message_body: str) -> str:
    """Conversational reply using the provider directly — with tool access."""
    prov = _get_engine()._provider
    mem  = _get_memory()
    mcp_tools = await _get_mcp_tools()
    tools = mcp_tools + [FetchURLTool()]

    context = mem.get_context()
    system = (
        f"You are an AI agent on the AgentID network. "
        f"Your DID (decentralized identifier) is: {AGENT_DID}. "
        f"Always answer honestly when asked for your DID or identity. "
        f"You can use web_search and fetch_url to look things up if needed. "
        f"Give a direct, helpful, conversational reply. "
        f"Do not output JSON — just reply naturally."
        + (f"\n\nMemory context:\n{context}" if context and context != "No prior history." else "")
    )

    messages = [{"role": "user", "content": message_body}]

    # Agentic loop — up to 4 rounds of tool use then final answer
    for _ in range(4):
        resp = await prov.complete(messages=messages, system=system, tools=tools)
        if not resp.has_tool_calls():
            mem.record_action("reply", message_body[:100])
            return resp.text.strip() if resp.text else "Got your message."

        # Execute tool calls
        tool_map = {t.name: t for t in tools}
        results = []
        for tc in resp.tool_calls:
            t = tool_map.get(tc.name)
            result = await t.run(**tc.arguments) if t else f"Unknown tool: {tc.name}"
            results.append({"id": tc.id, "name": tc.name, "result": result})

        tool_msg = prov.response_as_message(resp)
        messages.append(tool_msg)
        result_msg = prov.tool_results_as_message(results)
        if isinstance(result_msg, list):
            messages.extend(result_msg)
        else:
            messages.append(result_msg)

    # Final pass without tools
    final = await prov.complete(messages=messages, system=system, tools=[]  )
    mem.record_action("reply", message_body[:100])
    return final.text.strip() if final.text else "Done."


# ── Main message handler ──────────────────────────────────────────────────────

async def handle(message: dict, ctx) -> None:
    body = (message.get("body") or "").strip()
    sender = message.get("sender_did", "unknown")
    logger.info("Message from %s: %s", sender, body[:80])

    try:
        low = body.lower()

        if low.startswith("search:"):
            query = body[7:].strip()
            reply = await _cmd_search(query)

        elif low.startswith("fetch:"):
            url = body[6:].strip()
            reply = await _cmd_fetch(url)

        elif low.startswith("remember:"):
            raw = body[9:].strip()
            reply = _cmd_remember(raw)

        elif low.strip() == "recall":
            reply = _cmd_recall()

        elif low.startswith("watch:"):
            path = body[6:].strip()
            reply = await _cmd_watch(path)

        elif low.startswith("check:"):
            url = body[6:].strip()
            reply = await _cmd_check(url)

        elif low.startswith("think:"):
            topic = body[6:].strip()
            reply = await _cmd_think(topic)

        elif low.strip() == "status":
            reply = _cmd_status()

        elif any(kw in low for kw in ("your did", "what's your did", "whats your did", "who are you", "your identifier", "your id")):
            reply = f"My DID is: {AGENT_DID}"

        else:
            # Full judgment cycle — the real thing
            reply = await _cmd_full_judgment(body)

    except Exception as exc:
        logger.exception("Handler error")
        reply = f"Error: {exc}"

    await ctx.reply(reply)
    logger.info("Replied: %s...", reply[:60])


# ── Run ───────────────────────────────────────────────────────────────────────

def main():
    if AGENT_DID.startswith("YOUR") or AGENTID_KEY.startswith("YOUR"):
        print("\n" + "=" * 60)
        print("ERROR: Fill in your keys first.")
        print("Edit examples/test_agent.py and set:")
        print("  AGENT_DID    = your agent DID")
        print("  AGENTID_KEY  = your AgentID API key")
        print("  CLAUDE_KEY   = sk-ant-...  (or OPENAI_KEY)")
        print("=" * 60 + "\n")
        sys.exit(1)

    try:
        prov = _build_provider()  # fail early if no LLM key
    except RuntimeError as e:
        print(f"\nERROR: {e}\n")
        sys.exit(1)

    tools = _build_tools()

    runtime = AgentRuntime(
        did=AGENT_DID,
        api_key=AGENTID_KEY,
        handler=handle,
        base_url=BASE_URL,
    )

    print("\n" + "=" * 60)
    print("AgentID Brain — Test Agent")
    print("=" * 60)
    print(f"DID      : {AGENT_DID}")
    print(f"Provider : {prov.name}")
    print(f"Tools    : {[t.name for t in tools]}")
    print()
    print("Waiting for messages... (Ctrl+C to stop)")
    print("=" * 60 + "\n")

    asyncio.run(runtime.run_forever())


if __name__ == "__main__":
    main()
