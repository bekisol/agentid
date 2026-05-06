"""
MCPSession — bridge any MCP server into the brain's tool layer.

Connects to MCP servers (stdio subprocess or HTTP) and exposes their tools
as Tool instances that work with every LLM provider. The brain translates
MCP tool definitions → provider-native function calling format automatically.

This gives instant access to the entire MCP ecosystem without building
per-service connectors:

    @modelcontextprotocol/server-brave-search   web search
    @modelcontextprotocol/server-fetch          URL fetching
    @modelcontextprotocol/server-github         GitHub API
    @modelcontextprotocol/server-postgres       database queries
    @modelcontextprotocol/server-slack          Slack
    @modelcontextprotocol/server-filesystem     local files
    mcp-server-linear                           issue tracking
    ... hundreds more at https://github.com/modelcontextprotocol/servers

Usage — stdio (most MCP servers):
------
    from agentid.brain.tools.mcp import MCPSession

    async with MCPSession.stdio(
        "npx", ["-y", "@modelcontextprotocol/server-brave-search"],
        env={"BRAVE_API_KEY": "BSA..."},
    ) as session:
        tools = await session.tools()
        brain = AgentBrain(..., tools=tools)
        await brain.run()

Usage — HTTP (SSE or streamable-HTTP MCP servers):
------
    async with MCPSession.http("http://localhost:3000") as session:
        tools = await session.tools()
        brain = AgentBrain(..., tools=tools)
        await brain.run()

Usage — via AgentBrain convenience method:
------
    brain = AgentBrain(...)
    await brain.add_mcp_server(
        "npx", ["-y", "@modelcontextprotocol/server-brave-search"],
        env={"BRAVE_API_KEY": "BSA..."},
    )
    await brain.run()   # MCPSession lifetime managed by brain
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Optional

import httpx

from .base import Tool

logger = logging.getLogger(__name__)

_MCP_PROTOCOL_VERSION = "2024-11-05"
_STDIO_TIMEOUT = 30    # seconds to wait for a stdio response
_HTTP_TIMEOUT  = 30    # seconds for HTTP requests


# ── Proxy tool ─────────────────────────────────────────────────────────────────


class MCPProxyTool(Tool):
    """
    A Tool that delegates execution to an MCP server tool.

    Created automatically by MCPSession.tools(). You don't instantiate
    this directly — MCPSession creates one per tool the server exposes.
    """

    def __init__(self, session: "MCPSession", tool_def: dict) -> None:
        self.name        = tool_def["name"]
        self.description = tool_def.get("description", "")
        # MCP uses inputSchema (JSON Schema) — same format as our Tool.parameters
        self.parameters  = tool_def.get("inputSchema", {
            "type": "object", "properties": {},
        })
        self._session = session

    async def run(self, **kwargs) -> str:
        return await self._session.call_tool(self.name, kwargs)

    def __repr__(self) -> str:
        return f"MCPProxyTool(name={self.name!r}, server={self._session!r})"


# ── Session ────────────────────────────────────────────────────────────────────


class MCPSession:
    """
    Persistent connection to one MCP server.

    Create via class methods, then use as an async context manager:

        async with MCPSession.stdio("npx", ["-y", "..."]) as session:
            tools = await session.tools()

    Or connect manually and manage lifetime yourself:

        session = MCPSession.stdio("npx", ["-y", "..."])
        await session.connect()
        tools = await session.tools()
        # ... run brain ...
        await session.close()
    """

    # ── constructors ───────────────────────────────────────────────────────────

    def __init__(self) -> None:
        self._transport: str = ""
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._base_url: Optional[str] = None
        self._http_headers: dict = {}
        self._stdio_command: str = ""
        self._stdio_args: list[str] = []
        self._stdio_env: Optional[dict] = None
        self._req_id = 0
        self._connected = False

    @classmethod
    def stdio(
        cls,
        command: str,
        args: list[str] | None = None,
        env: dict | None = None,
    ) -> "MCPSession":
        """
        Create a stdio MCPSession.

        Parameters
        ----------
        command : str
            Executable to run (e.g. "npx", "python", "uvx").
        args : list[str]
            Arguments (e.g. ["-y", "@modelcontextprotocol/server-brave-search"]).
        env : dict | None
            Extra environment variables (merged with os.environ).
            Use this for API keys: {"BRAVE_API_KEY": "BSA..."}.
        """
        s = cls()
        s._transport       = "stdio"
        s._stdio_command   = command
        s._stdio_args      = args or []
        s._stdio_env       = env
        return s

    @classmethod
    def http(
        cls,
        url: str,
        headers: dict | None = None,
    ) -> "MCPSession":
        """
        Create an HTTP MCPSession.

        Parameters
        ----------
        url : str
            Base URL of the MCP server (e.g. "http://localhost:3000").
            Requests are sent to {url}/mcp.
        headers : dict | None
            Extra HTTP headers (e.g. Authorization).
        """
        s = cls()
        s._transport     = "http"
        s._base_url      = url.rstrip("/")
        s._http_headers  = headers or {}
        return s

    # ── context manager ───────────────────────────────────────────────────────

    async def __aenter__(self) -> "MCPSession":
        await self.connect()
        return self

    async def __aexit__(self, *_) -> None:
        await self.close()

    # ── public API ─────────────────────────────────────────────────────────────

    async def connect(self) -> None:
        """Connect to the MCP server and perform the initialize handshake."""
        if self._connected:
            return
        if self._transport == "stdio":
            await self._start_stdio()
        elif self._transport == "http":
            pass  # HTTP is stateless; handshake still required
        else:
            raise ValueError(f"Unknown transport: {self._transport!r}")
        await self._handshake()
        self._connected = True

    async def tools(self) -> list[Tool]:
        """
        Fetch the tool list from the server and return Tool instances.

        Each tool becomes an MCPProxyTool that delegates back here.
        """
        if not self._connected:
            await self.connect()
        result = await self._request("tools/list", {})
        tool_defs = result.get("tools", [])
        logger.info(
            "[brain/mcp] %s — %d tool(s): %s",
            self,
            len(tool_defs),
            [t["name"] for t in tool_defs],
        )
        return [MCPProxyTool(self, t) for t in tool_defs]

    async def call_tool(self, name: str, arguments: dict) -> str:
        """
        Call an MCP server tool and return the result as a string.

        MCP responses contain typed content blocks; this flattens them
        into a single string for the LLM to read.
        """
        result = await self._request(
            "tools/call",
            {"name": name, "arguments": arguments},
        )
        content = result.get("content", [])
        parts: list[str] = []
        for block in content:
            btype = block.get("type", "")
            if btype == "text":
                parts.append(block.get("text", ""))
            elif btype == "image":
                parts.append(f"[Image: {block.get('url', 'embedded')}]")
            elif btype == "resource":
                uri  = block.get("resource", {}).get("uri", "")
                text = block.get("resource", {}).get("text", "")
                parts.append(f"[Resource: {uri}]\n{text}" if text else f"[Resource: {uri}]")
            else:
                parts.append(str(block))

        if result.get("isError"):
            return "Tool error: " + "\n".join(parts)

        return "\n".join(parts) if parts else "(no output)"

    async def close(self) -> None:
        """Terminate subprocess or release HTTP resources."""
        if self._proc and self._proc.returncode is None:
            try:
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), timeout=5)
            except Exception:
                try:
                    self._proc.kill()
                except Exception:
                    pass
            self._proc = None
        self._connected = False
        logger.debug("[brain/mcp] session closed: %s", self)

    # ── connection internals ──────────────────────────────────────────────────

    async def _start_stdio(self) -> None:
        env = {**os.environ, **(self._stdio_env or {})}
        logger.info(
            "[brain/mcp] starting: %s %s",
            self._stdio_command,
            " ".join(self._stdio_args),
        )
        self._proc = await asyncio.create_subprocess_exec(
            self._stdio_command,
            *self._stdio_args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )

    async def _handshake(self) -> None:
        """MCP initialize → initialized sequence."""
        result = await self._request(
            "initialize",
            {
                "protocolVersion": _MCP_PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "clientInfo": {"name": "agentid-brain", "version": "0.4.0"},
            },
        )
        server_info = result.get("serverInfo", {})
        logger.info(
            "[brain/mcp] initialized — server=%s v%s",
            server_info.get("name", "unknown"),
            server_info.get("version", "?"),
        )
        # Notify server that initialization is complete (no response expected)
        await self._notify("notifications/initialized", {})

    # ── JSON-RPC ──────────────────────────────────────────────────────────────

    def _next_id(self) -> int:
        self._req_id += 1
        return self._req_id

    async def _request(self, method: str, params: dict) -> dict:
        req_id  = self._next_id()
        payload = {
            "jsonrpc": "2.0",
            "id":      req_id,
            "method":  method,
            "params":  params,
        }
        if self._transport == "stdio":
            return await self._stdio_rpc(payload)
        return await self._http_rpc(payload)

    async def _notify(self, method: str, params: dict) -> None:
        """Send a JSON-RPC notification (fire-and-forget, no id, no response)."""
        payload = {"jsonrpc": "2.0", "method": method, "params": params}
        if self._transport == "stdio" and self._proc and self._proc.stdin:
            line = json.dumps(payload) + "\n"
            self._proc.stdin.write(line.encode())
            await self._proc.stdin.drain()
        elif self._transport == "http":
            try:
                async with httpx.AsyncClient(timeout=5) as client:
                    await client.post(
                        f"{self._base_url}/mcp",
                        headers={"content-type": "application/json", **self._http_headers},
                        json=payload,
                    )
            except Exception:
                pass  # notifications are best-effort

    # ── stdio transport ───────────────────────────────────────────────────────

    async def _stdio_rpc(self, payload: dict) -> dict:
        if not self._proc or not self._proc.stdin:
            raise RuntimeError("MCP stdio process is not running")

        line = json.dumps(payload) + "\n"
        self._proc.stdin.write(line.encode())
        await self._proc.stdin.drain()

        # Read lines until we find the response matching our request id
        while True:
            try:
                raw = await asyncio.wait_for(
                    self._proc.stdout.readline(),
                    timeout=_STDIO_TIMEOUT,
                )
            except asyncio.TimeoutError:
                raise RuntimeError(
                    f"MCP stdio timeout ({_STDIO_TIMEOUT}s) "
                    f"waiting for response to: {payload['method']}"
                )

            if not raw:
                # Process died — read stderr for diagnostics
                stderr_bytes = b""
                if self._proc.stderr:
                    try:
                        stderr_bytes = await asyncio.wait_for(
                            self._proc.stderr.read(), timeout=2
                        )
                    except Exception:
                        pass
                raise RuntimeError(
                    f"MCP stdio process exited unexpectedly. "
                    f"Stderr: {stderr_bytes.decode(errors='replace')[:400]}"
                )

            try:
                msg = json.loads(raw.decode().strip())
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue  # skip malformed or empty lines

            # Match by request id; skip notifications (no "id" key)
            if msg.get("id") == payload["id"]:
                if "error" in msg:
                    err = msg["error"]
                    raise RuntimeError(
                        f"MCP error {err.get('code', '?')}: {err.get('message', 'unknown')}"
                    )
                return msg.get("result", {})
            # Notification or unrelated response — skip and keep reading

    # ── HTTP transport ────────────────────────────────────────────────────────

    async def _http_rpc(self, payload: dict) -> dict:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            resp = await client.post(
                f"{self._base_url}/mcp",
                headers={
                    "content-type": "application/json",
                    **self._http_headers,
                },
                json=payload,
            )

        if not resp.is_success:
            raise RuntimeError(
                f"MCP HTTP {resp.status_code}: {resp.text[:200]}"
            )

        msg = resp.json()
        if "error" in msg:
            err = msg["error"]
            raise RuntimeError(
                f"MCP error {err.get('code', '?')}: {err.get('message', 'unknown')}"
            )
        return msg.get("result", {})

    # ── repr ──────────────────────────────────────────────────────────────────

    def __repr__(self) -> str:
        if self._transport == "stdio":
            return (
                f"MCPSession(stdio={self._stdio_command!r} "
                f"{' '.join(self._stdio_args)!r})"
            )
        return f"MCPSession(http={self._base_url!r})"
