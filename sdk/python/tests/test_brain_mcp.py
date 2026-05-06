"""
Tests for agentid.brain.tools.mcp — MCPSession and MCPProxyTool.
"""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agentid.brain.tools.mcp import MCPSession, MCPProxyTool


# ── Helpers ────────────────────────────────────────────────────────────────────


def _make_rpc_response(req_id: int, result: dict) -> bytes:
    """Encode a JSON-RPC response as a newline-terminated byte line."""
    return (json.dumps({"jsonrpc": "2.0", "id": req_id, "result": result}) + "\n").encode()


def _make_init_response(req_id: int) -> bytes:
    return _make_rpc_response(req_id, {
        "protocolVersion": "2024-11-05",
        "capabilities": {"tools": {}},
        "serverInfo": {"name": "test-server", "version": "1.0"},
    })


def _make_tools_response(req_id: int, tools: list[dict]) -> bytes:
    return _make_rpc_response(req_id, {"tools": tools})


def _make_call_response(req_id: int, text: str, is_error: bool = False) -> bytes:
    return _make_rpc_response(req_id, {
        "content": [{"type": "text", "text": text}],
        "isError": is_error,
    })


SAMPLE_TOOLS = [
    {
        "name": "brave_web_search",
        "description": "Search the web using Brave Search.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "brave_local_search",
        "description": "Search for local businesses.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "location": {"type": "string"},
            },
            "required": ["query"],
        },
    },
]


# ── MCPSession.stdio ───────────────────────────────────────────────────────────


class TestMCPSessionStdio:
    def test_creates_stdio_session(self):
        session = MCPSession.stdio("npx", ["-y", "some-mcp-server"], env={"K": "V"})
        assert session._transport == "stdio"
        assert session._stdio_command == "npx"
        assert session._stdio_args == ["-y", "some-mcp-server"]
        assert session._stdio_env == {"K": "V"}

    def test_repr(self):
        session = MCPSession.stdio("npx", ["-y", "test-server"])
        assert "npx" in repr(session)
        assert "stdio" in repr(session)

    async def test_connect_and_list_tools(self):
        """Full handshake + tools/list via mocked subprocess."""
        session = MCPSession.stdio("npx", ["-y", "test-mcp-server"])

        # Simulate subprocess: each readline() call returns one pre-canned response
        responses = [
            _make_init_response(1),    # response to initialize (id=1)
            # id=2 is a notification (initialized) — no response needed
            _make_tools_response(2, SAMPLE_TOOLS),  # response to tools/list (id=2... wait, notify has no id)
        ]
        # Actually: initialize=id1, notify has no id (ignored), tools/list=id2
        responses = [
            _make_init_response(1),
            _make_tools_response(2, SAMPLE_TOOLS),
        ]

        mock_proc = MagicMock()
        mock_proc.returncode = None
        mock_proc.stdin = AsyncMock()
        mock_proc.stdin.write = MagicMock()
        mock_proc.stdin.drain = AsyncMock()
        mock_proc.stderr = AsyncMock()

        response_iter = iter(responses)

        async def fake_readline():
            try:
                return next(response_iter)
            except StopIteration:
                await asyncio.sleep(0)
                return b""

        mock_proc.stdout = AsyncMock()
        mock_proc.stdout.readline = fake_readline

        with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
            tools = await session.tools()

        assert len(tools) == 2
        assert tools[0].name == "brave_web_search"
        assert tools[1].name == "brave_local_search"
        assert isinstance(tools[0], MCPProxyTool)
        # Parameters should match inputSchema
        assert "query" in tools[0].parameters.get("properties", {})

    async def test_call_tool(self):
        """tool/call returns the text from MCP content blocks."""
        session = MCPSession.stdio("npx", ["-y", "test"])
        session._connected = True
        session._transport = "stdio"

        responses = [
            _make_call_response(1, "Brent crude: $82.15 (+3.2%)"),
        ]

        mock_proc = MagicMock()
        mock_proc.returncode = None
        mock_proc.stdin = AsyncMock()
        mock_proc.stdin.write = MagicMock()
        mock_proc.stdin.drain = AsyncMock()

        response_iter = iter(responses)

        async def fake_readline():
            try:
                return next(response_iter)
            except StopIteration:
                return b""

        mock_proc.stdout = AsyncMock()
        mock_proc.stdout.readline = fake_readline
        session._proc = mock_proc

        result = await session.call_tool("brave_web_search", {"query": "oil price"})
        assert "82.15" in result
        assert "+3.2%" in result

    async def test_tool_error_response(self):
        """isError=True in response should be reflected in the result string."""
        session = MCPSession.stdio("npx", ["-y", "test"])
        session._connected = True
        session._transport = "stdio"

        mock_proc = MagicMock()
        mock_proc.returncode = None
        mock_proc.stdin = AsyncMock()
        mock_proc.stdin.write = MagicMock()
        mock_proc.stdin.drain = AsyncMock()

        async def fake_readline():
            return _make_call_response(1, "API key invalid", is_error=True)

        mock_proc.stdout = AsyncMock()
        mock_proc.stdout.readline = fake_readline
        session._proc = mock_proc

        result = await session.call_tool("brave_web_search", {"query": "test"})
        assert "error" in result.lower() or "invalid" in result.lower()

    async def test_process_death_raises(self):
        """Empty readline (process died) should raise RuntimeError."""
        session = MCPSession.stdio("npx", ["-y", "test"])
        session._connected = True
        session._transport = "stdio"

        mock_proc = MagicMock()
        mock_proc.returncode = None
        mock_proc.stdin = AsyncMock()
        mock_proc.stdin.write = MagicMock()
        mock_proc.stdin.drain = AsyncMock()
        mock_proc.stderr = AsyncMock()
        mock_proc.stderr.read = AsyncMock(return_value=b"server crashed")

        async def fake_readline():
            return b""  # process died

        mock_proc.stdout = AsyncMock()
        mock_proc.stdout.readline = fake_readline
        session._proc = mock_proc

        with pytest.raises(RuntimeError, match="exited unexpectedly"):
            await session.call_tool("test_tool", {})

    async def test_close_terminates_process(self):
        """close() should call terminate() on the subprocess."""
        session = MCPSession.stdio("npx", ["-y", "test"])
        mock_proc = MagicMock()
        mock_proc.returncode = None
        mock_proc.terminate = MagicMock()
        mock_proc.wait = AsyncMock(return_value=0)
        session._proc = mock_proc
        session._connected = True

        await session.close()

        mock_proc.terminate.assert_called_once()
        assert session._connected is False

    async def test_context_manager(self):
        """async with MCPSession should auto-close on exit."""
        session = MCPSession.stdio("npx", ["-y", "test"])
        session.connect = AsyncMock()
        session.close = AsyncMock()

        async with session:
            pass

        session.connect.assert_called_once()
        session.close.assert_called_once()


# ── MCPSession.http ────────────────────────────────────────────────────────────


class TestMCPSessionHTTP:
    def test_creates_http_session(self):
        session = MCPSession.http("http://localhost:3000", headers={"X-Key": "v"})
        assert session._transport == "http"
        assert session._base_url == "http://localhost:3000"
        assert session._http_headers == {"X-Key": "v"}

    def test_repr(self):
        session = MCPSession.http("http://localhost:3000")
        assert "http" in repr(session)
        assert "3000" in repr(session)

    async def test_list_tools_http(self):
        """HTTP transport: tools/list should POST to /mcp and parse response."""
        session = MCPSession.http("http://localhost:3000")
        session._connected = True  # skip handshake for this test

        call_count = 0

        async def fake_post(url, **kwargs):
            nonlocal call_count
            call_count += 1
            payload = kwargs.get("json", {})
            mock_resp = MagicMock()
            mock_resp.is_success = True

            if payload.get("method") == "tools/list":
                mock_resp.json.return_value = {
                    "jsonrpc": "2.0",
                    "id": payload["id"],
                    "result": {"tools": SAMPLE_TOOLS},
                }
            else:
                mock_resp.json.return_value = {
                    "jsonrpc": "2.0",
                    "id": payload.get("id"),
                    "result": {},
                }
            return mock_resp

        with patch("httpx.AsyncClient") as MockClient:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client.post = fake_post
            MockClient.return_value = mock_client

            tools = await session.tools()

        assert len(tools) == 2
        assert tools[0].name == "brave_web_search"

    async def test_call_tool_http(self):
        session = MCPSession.http("http://localhost:3000")
        session._connected = True

        async def fake_post(url, **kwargs):
            mock_resp = MagicMock()
            mock_resp.is_success = True
            mock_resp.json.return_value = {
                "jsonrpc": "2.0",
                "id": kwargs["json"]["id"],
                "result": {
                    "content": [{"type": "text", "text": "Oil at $80"}],
                    "isError": False,
                },
            }
            return mock_resp

        with patch("httpx.AsyncClient") as MockClient:
            mc = AsyncMock()
            mc.__aenter__ = AsyncMock(return_value=mc)
            mc.__aexit__ = AsyncMock(return_value=False)
            mc.post = fake_post
            MockClient.return_value = mc

            result = await session.call_tool("get_price", {"ticker": "BZ=F"})

        assert "Oil at $80" in result

    async def test_http_error_raises(self):
        session = MCPSession.http("http://localhost:3000")
        session._connected = True

        async def fake_post(url, **kwargs):
            mock_resp = MagicMock()
            mock_resp.is_success = False
            mock_resp.status_code = 500
            mock_resp.text = "Internal Server Error"
            return mock_resp

        with patch("httpx.AsyncClient") as MockClient:
            mc = AsyncMock()
            mc.__aenter__ = AsyncMock(return_value=mc)
            mc.__aexit__ = AsyncMock(return_value=False)
            mc.post = fake_post
            MockClient.return_value = mc

            with pytest.raises(RuntimeError, match="500"):
                await session.call_tool("test", {})


# ── MCPProxyTool ───────────────────────────────────────────────────────────────


class TestMCPProxyTool:
    def test_inherits_tool_definition(self):
        session = MagicMock()
        tool_def = {
            "name": "brave_web_search",
            "description": "Search the web.",
            "inputSchema": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        }
        tool = MCPProxyTool(session, tool_def)
        assert tool.name == "brave_web_search"
        assert tool.description == "Search the web."
        assert tool.parameters["type"] == "object"

    async def test_run_delegates_to_session(self):
        session = MagicMock()
        session.call_tool = AsyncMock(return_value="oil price: $82")
        tool = MCPProxyTool(session, {"name": "get_price", "description": "", "inputSchema": {}})

        result = await tool.run(ticker="BZ=F")

        session.call_tool.assert_called_once_with("get_price", {"ticker": "BZ=F"})
        assert result == "oil price: $82"

    def test_repr(self):
        session = MagicMock()
        tool = MCPProxyTool(session, {"name": "my_tool", "description": ""})
        assert "my_tool" in repr(tool)


# ── AgentBrain.add_mcp_server ─────────────────────────────────────────────────


class TestAgentBrainMCPIntegration:
    @pytest.fixture
    def brain(self, tmp_path, monkeypatch):
        import agentid.brain.memory.store as m
        monkeypatch.setattr(m, "BRAIN_DIR", tmp_path / "brain")
        from agentid.brain import AgentBrain
        from agentid.brain.providers.base import ProviderResponse
        import json

        provider = MagicMock()
        provider.name = "mock"
        provider.format_tools.return_value = []
        provider.response_as_message.return_value = {}
        provider.tool_results_as_message.return_value = {}
        provider.complete = AsyncMock(
            return_value=ProviderResponse(
                text=json.dumps({
                    "should_act": False,
                    "reasoning": "quiet",
                    "summary": "All quiet",
                    "actions": [],
                })
            )
        )
        return AgentBrain(
            agent_did="did:agentid:test",
            api_key="k",
            mission="test",
            provider=provider,
            tools=[],
        )

    async def test_add_mcp_server_injects_tools(self, brain):
        """add_mcp_server should add MCPProxyTools to the judgment engine."""
        mock_session = MagicMock()
        mock_session.connect = AsyncMock()
        mock_session.tools = AsyncMock(return_value=[
            MCPProxyTool(mock_session, {
                "name": "brave_web_search",
                "description": "search",
                "inputSchema": {"type": "object", "properties": {}},
            }),
        ])
        mock_session.close = AsyncMock()

        with patch("agentid.brain.tools.mcp.MCPSession.stdio", return_value=mock_session):
            await brain.add_mcp_server("npx", ["-y", "server"])

        # Tool should now be in the judgment engine registry
        assert "brave_web_search" in brain._judgment._registry
        assert len(brain._mcp_sessions) == 1

    async def test_mcp_sessions_closed_on_stop(self, brain):
        """When brain stops, all MCP sessions should be closed."""
        mock_session = MagicMock()
        mock_session.close = AsyncMock()
        brain._mcp_sessions.append(mock_session)

        # Simulate a very fast run + stop
        async def stop_soon():
            await asyncio.sleep(0.05)
            brain.stop()

        from agentid.brain.triggers import IntervalTrigger
        brain.add_trigger(IntervalTrigger(seconds=10))

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await asyncio.gather(brain.run(), stop_soon(), return_exceptions=True)

        mock_session.close.assert_called_once()

    async def test_add_mcp_server_returns_self(self, brain):
        """add_mcp_server should return the brain for chaining."""
        mock_session = MagicMock()
        mock_session.connect = AsyncMock()
        mock_session.tools = AsyncMock(return_value=[])
        mock_session.close = AsyncMock()

        with patch("agentid.brain.tools.mcp.MCPSession.stdio", return_value=mock_session):
            result = await brain.add_mcp_server("npx", [])

        assert result is brain
