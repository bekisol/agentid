"""
Tests for agentid.runtime — AgentRuntime, MessageContext, handlers, config.

Run with:
    pytest tests/test_runtime.py -v
"""

from __future__ import annotations

import asyncio
import json
from typing import Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agentid.runtime import (
    AgentRuntime,
    AsyncAgentIDClient,
    MessageContext,
    echo_handler,
    keyword_router,
    static_reply,
)
from agentid.runtime.config import AgentConfig, RuntimeConfig


# ── helpers ───────────────────────────────────────────────────────────────────

def make_message(
    body: str = "hello",
    msg_id: int = 1,
    from_did: str = "did:agentid:sender",
    to_did: str = "did:agentid:agent",
) -> dict:
    return {
        "id": msg_id,
        "from_did": from_did,
        "to_did": to_did,
        "body": body,
        "content_type": "text/plain",
    }


def make_mock_client(send_return: dict | None = None) -> MagicMock:
    client = MagicMock(spec=AsyncAgentIDClient)
    client.send_message = AsyncMock(return_value=send_return or {"id": 99})
    client.get_messages = AsyncMock(return_value=[])
    client.poll_messages = AsyncMock(return_value=[])
    return client


def make_ctx(message: dict, runtime: AgentRuntime | None = None) -> MessageContext:
    """Build a MessageContext with a mock client for testing."""
    mock_runtime = runtime or MagicMock(spec=AgentRuntime, messages_processed=0)
    mock_client = make_mock_client()
    return MessageContext(
        message=message,
        agent_did="did:agentid:agent",
        _client=mock_client,
        _runtime=mock_runtime,
    )


# ── MessageContext ─────────────────────────────────────────────────────────────


class TestMessageContext:
    @pytest.mark.asyncio
    async def test_reply_sends_to_from_did(self):
        msg = make_message(body="ping", from_did="did:agentid:alice")
        ctx = make_ctx(msg)
        await ctx.reply("pong")
        ctx._client.send_message.assert_awaited_once_with(
            from_did="did:agentid:agent",
            to_did="did:agentid:alice",
            body="pong",
            content_type="text/plain",
        )

    @pytest.mark.asyncio
    async def test_reply_raises_if_no_sender(self):
        msg = {"id": 1, "body": "hi"}  # no from_did
        ctx = make_ctx(msg)
        with pytest.raises(ValueError, match="no from_did"):
            await ctx.reply("hello back")

    @pytest.mark.asyncio
    async def test_fetch_history_delegates(self):
        msg = make_message()
        ctx = make_ctx(msg)
        await ctx.fetch_history(limit=5)
        ctx._client.get_messages.assert_awaited_once_with("did:agentid:agent", limit=5)

    def test_metrics_includes_expected_keys(self):
        msg = make_message(msg_id=42)
        ctx = make_ctx(msg)
        m = ctx.metrics
        assert m["message_id"] == 42
        assert "elapsed_ms" in m
        assert m["agent_did"] == "did:agentid:agent"


# ── built-in handlers ─────────────────────────────────────────────────────────


class TestEchoHandler:
    @pytest.mark.asyncio
    async def test_echoes_body(self):
        msg = make_message(body="world")
        ctx = make_ctx(msg)
        result = await echo_handler(msg, ctx)
        assert result == "Echo: world"

    @pytest.mark.asyncio
    async def test_empty_body(self):
        msg = make_message(body="")
        ctx = make_ctx(msg)
        result = await echo_handler(msg, ctx)
        assert result == "Echo: "


class TestStaticReply:
    @pytest.mark.asyncio
    async def test_always_returns_fixed_text(self):
        msg = make_message(body="anything")
        ctx = make_ctx(msg)
        handler = static_reply("I am busy")
        result = await handler(msg, ctx)
        assert result == "I am busy"


class TestKeywordRouter:
    @pytest.mark.asyncio
    async def test_routes_by_keyword(self):
        msg = make_message(body="hello world")
        ctx = make_ctx(msg)
        handler = keyword_router(
            ("hello", lambda m, c: "Hi!"),
            ("bye", lambda m, c: "Goodbye!"),
        )
        result = await handler(msg, ctx)
        assert result == "Hi!"

    @pytest.mark.asyncio
    async def test_first_match_wins(self):
        msg = make_message(body="hello bye")
        ctx = make_ctx(msg)
        handler = keyword_router(
            ("hello", lambda m, c: "Hi!"),
            ("bye", lambda m, c: "Goodbye!"),
        )
        result = await handler(msg, ctx)
        assert result == "Hi!"

    @pytest.mark.asyncio
    async def test_default_when_no_match(self):
        msg = make_message(body="something else")
        ctx = make_ctx(msg)
        handler = keyword_router(
            ("hello", lambda m, c: "Hi!"),
            default=lambda m, c: "No match",
        )
        result = await handler(msg, ctx)
        assert result == "No match"

    @pytest.mark.asyncio
    async def test_returns_none_no_match_no_default(self):
        msg = make_message(body="xyz")
        ctx = make_ctx(msg)
        handler = keyword_router(("hello", lambda m, c: "Hi!"))
        result = await handler(msg, ctx)
        assert result is None

    @pytest.mark.asyncio
    async def test_case_insensitive_by_default(self):
        msg = make_message(body="HELLO")
        ctx = make_ctx(msg)
        handler = keyword_router(("hello", lambda m, c: "Hi!"))
        result = await handler(msg, ctx)
        assert result == "Hi!"

    @pytest.mark.asyncio
    async def test_case_sensitive_when_requested(self):
        msg = make_message(body="HELLO")
        ctx = make_ctx(msg)
        handler = keyword_router(
            ("hello", lambda m, c: "Hi!"),
            case_sensitive=True,
        )
        result = await handler(msg, ctx)
        assert result is None


# ── AgentRuntime ──────────────────────────────────────────────────────────────


class TestAgentRuntime:
    def test_init_loads_cursor(self, tmp_path):
        cursor_dir = tmp_path / "cursors"
        cursor_dir.mkdir()
        safe_did = "did_agentid_abc"
        (cursor_dir / f"{safe_did}.cursor").write_text("99")

        with patch("agentid.runtime.runtime.CURSOR_DIR", cursor_dir):
            rt = AgentRuntime(
                did="did:agentid:abc",
                api_key="ak_test",
                handler=echo_handler,
            )
        assert rt._since_id == 99

    def test_init_no_cursor_is_none(self, tmp_path):
        with patch("agentid.runtime.runtime.CURSOR_DIR", tmp_path / "empty"):
            rt = AgentRuntime(
                did="did:agentid:abc",
                api_key="ak_test",
                handler=echo_handler,
            )
        assert rt._since_id is None

    @pytest.mark.asyncio
    async def test_dispatch_calls_handler_and_auto_replies(self):
        replied: list[str] = []

        async def handler(msg, ctx):
            return "auto reply"

        rt = AgentRuntime(did="did:agentid:agent", api_key="ak", handler=handler)
        msg = make_message()

        mock_client = make_mock_client()
        ctx = MessageContext(
            message=msg,
            agent_did="did:agentid:agent",
            _client=mock_client,
            _runtime=rt,
        )

        with patch.object(rt, "_client", mock_client):
            # patch MessageContext creation inside _dispatch
            with patch("agentid.runtime.runtime.MessageContext", return_value=ctx):
                await rt._dispatch(msg)

        mock_client.send_message.assert_awaited_once()
        assert rt.messages_processed == 1

    @pytest.mark.asyncio
    async def test_dispatch_no_reply_when_handler_returns_none(self):
        async def handler(msg, ctx):
            return None

        rt = AgentRuntime(did="did:agentid:agent", api_key="ak", handler=handler)
        msg = make_message()
        mock_client = make_mock_client()

        ctx = MessageContext(
            message=msg,
            agent_did="did:agentid:agent",
            _client=mock_client,
            _runtime=rt,
        )
        with patch("agentid.runtime.runtime.MessageContext", return_value=ctx):
            await rt._dispatch(msg)

        mock_client.send_message.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_dispatch_handles_sync_handler(self):
        def sync_handler(msg, ctx):
            return "sync reply"

        rt = AgentRuntime(did="did:agentid:agent", api_key="ak", handler=sync_handler)
        msg = make_message()
        mock_client = make_mock_client()

        ctx = MessageContext(
            message=msg,
            agent_did="did:agentid:agent",
            _client=mock_client,
            _runtime=rt,
        )
        with patch("agentid.runtime.runtime.MessageContext", return_value=ctx):
            await rt._dispatch(msg)

        mock_client.send_message.assert_awaited_once()

    def test_stop_sets_event(self):
        rt = AgentRuntime(did="did:agentid:x", api_key="ak", handler=echo_handler)
        rt._stop_event = asyncio.Event()
        assert not rt._stop_event.is_set()
        rt.stop()
        assert rt._stop_event.is_set()


# ── RuntimeConfig ─────────────────────────────────────────────────────────────


class TestRuntimeConfig:
    def test_from_env(self, monkeypatch):
        monkeypatch.setenv("AGENTID_DID", "did:agentid:env")
        monkeypatch.setenv("AGENTID_API_KEY", "ak_env")
        monkeypatch.setenv("AGENTID_POLL_TIMEOUT", "45")
        monkeypatch.setenv("AGENTID_CONCURRENCY", "8")
        monkeypatch.setenv("AGENTID_HEALTH_PORT", "9090")

        cfg = RuntimeConfig.from_env()
        assert cfg.agent.did == "did:agentid:env"
        assert cfg.agent.api_key == "ak_env"
        assert cfg.poll_timeout == 45
        assert cfg.concurrency == 8
        assert cfg.health_port == 9090

    def test_from_env_missing_did_raises(self, monkeypatch):
        monkeypatch.delenv("AGENTID_DID", raising=False)
        monkeypatch.setenv("AGENTID_API_KEY", "ak_x")
        with pytest.raises(ValueError, match="AGENTID_DID"):
            RuntimeConfig.from_env()

    def test_from_env_missing_key_raises(self, monkeypatch):
        monkeypatch.setenv("AGENTID_DID", "did:agentid:x")
        monkeypatch.delenv("AGENTID_API_KEY", raising=False)
        with pytest.raises(ValueError, match="AGENTID_API_KEY"):
            RuntimeConfig.from_env()

    def test_from_toml(self, tmp_path):
        toml = tmp_path / "agent.toml"
        toml.write_text(
            "[agent]\n"
            'did = "did:agentid:toml"\n'
            'api_key = "ak_toml"\n'
            "\n"
            "[runtime]\n"
            "poll_timeout = 20\n"
            "concurrency = 2\n"
            "health_port = 7777\n"
        )
        cfg = RuntimeConfig.from_toml(toml)
        assert cfg.agent.did == "did:agentid:toml"
        assert cfg.poll_timeout == 20
        assert cfg.health_port == 7777

    def test_from_toml_env_overrides_file(self, tmp_path, monkeypatch):
        toml = tmp_path / "agent.toml"
        toml.write_text(
            "[agent]\n"
            'did = "did:agentid:toml"\n'
            'api_key = "ak_toml"\n'
        )
        monkeypatch.setenv("AGENTID_DID", "did:agentid:env_override")
        cfg = RuntimeConfig.from_toml(toml)
        assert cfg.agent.did == "did:agentid:env_override"

    def test_build_runtime_returns_agent_runtime(self, monkeypatch):
        monkeypatch.setenv("AGENTID_DID", "did:agentid:x")
        monkeypatch.setenv("AGENTID_API_KEY", "ak_x")
        cfg = RuntimeConfig.from_env()
        rt = cfg.build_runtime(echo_handler)
        assert isinstance(rt, AgentRuntime)
        assert rt.did == "did:agentid:x"
