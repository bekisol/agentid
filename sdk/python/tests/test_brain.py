"""
Tests for agentid.brain — multi-provider, tool-use, judgment, actions, triggers.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agentid.brain import (
    AgentBrain,
    BrainMemory,
    FilePerception,
    APIPerception,
    IntervalTrigger,
    DailyTrigger,
    OnChangeTrigger,
    JudgmentEngine,
    JudgmentResult,
    parse_action,
    SendMessageAction,
    FindAndContactAction,
    AlertOwnerAction,
    StoreNoteAction,
    AnthropicProvider,
    OpenAIProvider,
    GeminiProvider,
    WebSearchTool,
    FetchURLTool,
)
from agentid.brain.perception.base import Perception, PerceptionData
from agentid.brain.providers.base import ProviderResponse, ToolCall
from agentid.brain.tools.base import Tool


# ── Fixtures ───────────────────────────────────────────────────────────────────


@pytest.fixture
def mock_provider():
    """A mock LLMProvider that returns a simple judgment JSON."""
    p = MagicMock()
    p.name = "mock"
    p.format_tools.return_value = []
    p.response_as_message.return_value = {}
    p.tool_results_as_message.return_value = {}

    good_judgment = json.dumps({
        "should_act": False,
        "reasoning": "nothing important",
        "summary": "All quiet",
        "actions": [],
    })
    p.complete = AsyncMock(
        return_value=ProviderResponse(text=good_judgment, tool_calls=[])
    )
    return p


@pytest.fixture
def brain(tmp_path, monkeypatch, mock_provider):
    import agentid.brain.memory.store as store_mod
    monkeypatch.setattr(store_mod, "BRAIN_DIR", tmp_path / "brain")
    return AgentBrain(
        agent_did="did:agentid:test",
        api_key="k",
        mission="test mission",
        provider=mock_provider,
        tools=[],
    )


# ── BrainMemory ────────────────────────────────────────────────────────────────


class TestBrainMemory:
    def test_empty(self, tmp_path, monkeypatch):
        import agentid.brain.memory.store as m
        monkeypatch.setattr(m, "BRAIN_DIR", tmp_path / "brain")
        mem = BrainMemory("did:agentid:x")
        assert mem.get_perception_state("src") is None

    def test_perception_roundtrip(self, tmp_path, monkeypatch):
        import agentid.brain.memory.store as m
        monkeypatch.setattr(m, "BRAIN_DIR", tmp_path / "brain")
        mem = BrainMemory("did:agentid:x")
        mem.set_perception_state("git:repo", "abc123")
        assert mem.get_perception_state("git:repo") == "abc123"

    def test_history_capped(self, tmp_path, monkeypatch):
        import agentid.brain.memory.store as m
        monkeypatch.setattr(m, "BRAIN_DIR", tmp_path / "brain")
        mem = BrainMemory("did:agentid:x")
        for i in range(250):
            mem.record_action("test", f"item {i}")
        assert len(mem._data["history"]) == 200

    def test_notes(self, tmp_path, monkeypatch):
        import agentid.brain.memory.store as m
        monkeypatch.setattr(m, "BRAIN_DIR", tmp_path / "brain")
        mem = BrainMemory("did:agentid:x")
        mem.set_note("owner_did", "did:agentid:alice")
        assert mem.get_note("owner_did") == "did:agentid:alice"

    def test_context_empty(self, tmp_path, monkeypatch):
        import agentid.brain.memory.store as m
        monkeypatch.setattr(m, "BRAIN_DIR", tmp_path / "brain")
        mem = BrainMemory("did:agentid:x")
        assert mem.get_context() == "No prior history."

    def test_context_with_data(self, tmp_path, monkeypatch):
        import agentid.brain.memory.store as m
        monkeypatch.setattr(m, "BRAIN_DIR", tmp_path / "brain")
        mem = BrainMemory("did:agentid:x")
        mem.record_action("send_message", "→ bob")
        mem.set_note("key", "value")
        ctx = mem.get_context()
        assert "send_message" in ctx


# ── Providers ─────────────────────────────────────────────────────────────────


class TestAnthropicProvider:
    def test_name(self):
        p = AnthropicProvider(api_key="sk-ant-x")
        assert p.name == "anthropic"

    def test_format_tools(self):
        tool = MagicMock(spec=Tool)
        tool.name = "web_search"
        tool.description = "search"
        tool.parameters = {"type": "object", "properties": {}, "required": []}
        p = AnthropicProvider(api_key="sk-ant-x")
        formatted = p.format_tools([tool])
        assert formatted[0]["name"] == "web_search"
        assert "input_schema" in formatted[0]

    def test_tool_results_as_message(self):
        p = AnthropicProvider(api_key="sk-ant-x")
        msg = p.tool_results_as_message([("id1", "web_search", "oil price: $80")])
        assert msg["role"] == "user"
        assert msg["content"][0]["type"] == "tool_result"
        assert msg["content"][0]["tool_use_id"] == "id1"

    async def test_complete_success(self):
        p = AnthropicProvider(api_key="sk-ant-x")
        mock_resp = MagicMock()
        mock_resp.is_success = True
        mock_resp.json.return_value = {
            "stop_reason": "end_turn",
            "content": [{"type": "text", "text": '{"should_act": false}'}],
        }
        with patch("httpx.AsyncClient") as MockClient:
            mc = AsyncMock()
            mc.__aenter__ = AsyncMock(return_value=mc)
            mc.__aexit__ = AsyncMock(return_value=False)
            mc.post = AsyncMock(return_value=mock_resp)
            MockClient.return_value = mc
            resp = await p.complete(
                [{"role": "user", "content": "hello"}],
                system="sys",
                tools=[],
            )
        assert resp.text is not None
        assert not resp.has_tool_calls()

    async def test_complete_tool_call(self):
        p = AnthropicProvider(api_key="sk-ant-x")
        mock_resp = MagicMock()
        mock_resp.is_success = True
        mock_resp.json.return_value = {
            "stop_reason": "tool_use",
            "content": [
                {
                    "type": "tool_use",
                    "id": "tu_1",
                    "name": "web_search",
                    "input": {"query": "oil price"},
                }
            ],
        }
        with patch("httpx.AsyncClient") as MockClient:
            mc = AsyncMock()
            mc.__aenter__ = AsyncMock(return_value=mc)
            mc.__aexit__ = AsyncMock(return_value=False)
            mc.post = AsyncMock(return_value=mock_resp)
            MockClient.return_value = mc
            resp = await p.complete([], system="sys", tools=[])
        assert resp.has_tool_calls()
        assert resp.tool_calls[0].name == "web_search"
        assert resp.tool_calls[0].arguments == {"query": "oil price"}


class TestOpenAIProvider:
    def test_name_openai(self):
        assert OpenAIProvider(api_key="sk-x").name == "openai"

    def test_name_grok(self):
        p = OpenAIProvider(api_key="xai-x", base_url="https://api.x.ai/v1", model="grok-3")
        assert p.name == "grok"

    def test_name_ollama(self):
        p = OpenAIProvider(api_key="ollama", base_url="http://localhost:11434/v1")
        assert p.name == "ollama"

    def test_name_groq(self):
        p = OpenAIProvider(api_key="gsk_x", base_url="https://api.groq.com/openai/v1")
        assert p.name == "groq"

    def test_format_tools(self):
        tool = MagicMock(spec=Tool)
        tool.name = "web_search"
        tool.description = "search"
        tool.parameters = {}
        p = OpenAIProvider(api_key="sk-x")
        fmt = p.format_tools([tool])
        assert fmt[0]["type"] == "function"
        assert fmt[0]["function"]["name"] == "web_search"

    def test_tool_results_as_message(self):
        p = OpenAIProvider(api_key="sk-x")
        msgs = p.tool_results_as_message([("call_1", "web_search", "result")])
        assert isinstance(msgs, list)
        assert msgs[0]["role"] == "tool"
        assert msgs[0]["tool_call_id"] == "call_1"

    async def test_complete_with_tool_call(self):
        p = OpenAIProvider(api_key="sk-x")
        mock_resp = MagicMock()
        mock_resp.is_success = True
        mock_resp.json.return_value = {
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call_abc",
                                "type": "function",
                                "function": {
                                    "name": "web_search",
                                    "arguments": '{"query": "OPEC news"}',
                                },
                            }
                        ],
                    },
                }
            ]
        }
        with patch("httpx.AsyncClient") as MockClient:
            mc = AsyncMock()
            mc.__aenter__ = AsyncMock(return_value=mc)
            mc.__aexit__ = AsyncMock(return_value=False)
            mc.post = AsyncMock(return_value=mock_resp)
            MockClient.return_value = mc
            resp = await p.complete([], system="sys", tools=[])
        assert resp.has_tool_calls()
        assert resp.tool_calls[0].name == "web_search"
        assert resp.tool_calls[0].arguments == {"query": "OPEC news"}


class TestGeminiProvider:
    def test_name(self):
        assert GeminiProvider(api_key="AIza-x").name == "gemini"

    def test_tool_results_as_message(self):
        p = GeminiProvider(api_key="AIza-x")
        msg = p.tool_results_as_message([("id1", "web_search", "result text")])
        assert msg["role"] == "user"
        assert msg["parts"][0]["functionResponse"]["name"] == "web_search"

    def test_schema_conversion(self):
        from agentid.brain.providers.gemini import _to_gemini_schema
        schema = {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]}
        gemini = _to_gemini_schema(schema)
        assert gemini["type"] == "OBJECT"
        assert gemini["properties"]["q"]["type"] == "STRING"


# ── Tools ─────────────────────────────────────────────────────────────────────


class TestWebSearchTool:
    async def test_ddg_fallback_no_key(self):
        tool = WebSearchTool()
        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "Abstract": "Brent crude is a grade of oil.",
            "AbstractURL": "https://en.wikipedia.org/wiki/Brent_Crude",
            "Answer": "",
            "RelatedTopics": [],
        }
        with patch("httpx.AsyncClient") as MockClient:
            mc = AsyncMock()
            mc.__aenter__ = AsyncMock(return_value=mc)
            mc.__aexit__ = AsyncMock(return_value=False)
            mc.get = AsyncMock(return_value=mock_resp)
            MockClient.return_value = mc
            result = await tool.run("Brent crude oil")
        assert "Brent" in result or "oil" in result.lower()

    async def test_brave_search(self):
        tool = WebSearchTool(api_key="BSA_fake_key")
        mock_resp = MagicMock()
        mock_resp.is_success = True
        mock_resp.json.return_value = {
            "web": {
                "results": [
                    {
                        "title": "OPEC Cuts Production",
                        "url": "https://reuters.com/opec-cuts",
                        "description": "OPEC+ agreed to cut production by 1M barrels.",
                    }
                ]
            }
        }
        with patch("httpx.AsyncClient") as MockClient:
            mc = AsyncMock()
            mc.__aenter__ = AsyncMock(return_value=mc)
            mc.__aexit__ = AsyncMock(return_value=False)
            mc.get = AsyncMock(return_value=mock_resp)
            MockClient.return_value = mc
            result = await tool.run("OPEC production cut")
        assert "OPEC" in result
        assert "reuters.com" in result


class TestFetchURLTool:
    async def test_fetches_html(self):
        tool = FetchURLTool()
        mock_resp = MagicMock()
        mock_resp.is_success = True
        mock_resp.headers = {"content-type": "text/html"}
        mock_resp.text = "<html><body><h1>Oil Price Alert</h1><p>Brent rose 5%.</p></body></html>"
        with patch("httpx.AsyncClient") as MockClient:
            mc = AsyncMock()
            mc.__aenter__ = AsyncMock(return_value=mc)
            mc.__aexit__ = AsyncMock(return_value=False)
            mc.get = AsyncMock(return_value=mock_resp)
            MockClient.return_value = mc
            result = await tool.run("https://example.com/oil")
        assert "Oil Price Alert" in result
        assert "5%" in result

    async def test_fetches_json(self):
        tool = FetchURLTool()
        mock_resp = MagicMock()
        mock_resp.is_success = True
        mock_resp.headers = {"content-type": "application/json"}
        mock_resp.text = '{"price": 85.42, "change": "+5.2%"}'
        with patch("httpx.AsyncClient") as MockClient:
            mc = AsyncMock()
            mc.__aenter__ = AsyncMock(return_value=mc)
            mc.__aexit__ = AsyncMock(return_value=False)
            mc.get = AsyncMock(return_value=mock_resp)
            MockClient.return_value = mc
            result = await tool.run("https://api.example.com/oil-price")
        assert "85.42" in result

    async def test_invalid_url(self):
        tool = FetchURLTool()
        result = await tool.run("not-a-url")
        assert "Invalid URL" in result

    async def test_truncates_long_content(self):
        tool = FetchURLTool(max_chars=100)
        mock_resp = MagicMock()
        mock_resp.is_success = True
        mock_resp.headers = {"content-type": "text/plain"}
        mock_resp.text = "x" * 500
        with patch("httpx.AsyncClient") as MockClient:
            mc = AsyncMock()
            mc.__aenter__ = AsyncMock(return_value=mc)
            mc.__aexit__ = AsyncMock(return_value=False)
            mc.get = AsyncMock(return_value=mock_resp)
            MockClient.return_value = mc
            result = await tool.run("https://example.com")
        assert "truncated" in result


# ── JudgmentEngine (agentic loop) ─────────────────────────────────────────────


class TestJudgmentEngine:
    async def test_direct_answer_no_tools(self, mock_provider):
        engine = JudgmentEngine(provider=mock_provider, tools=[])
        perceptions = [
            PerceptionData(source="test", content="data", changed=False, state_token="x")
        ]
        result = await engine.judge("test mission", perceptions)
        assert result.should_act is False
        assert result.summary == "All quiet"
        assert mock_provider.complete.call_count == 1

    async def test_tool_use_then_judgment(self, mock_provider):
        """LLM calls web_search once, then outputs final JSON."""
        tool_response = ProviderResponse(
            text=None,
            tool_calls=[ToolCall(id="c1", name="web_search", arguments={"query": "oil price"})],
            stop_reason="tool_use",
        )
        final_response = ProviderResponse(
            text=json.dumps({
                "should_act": True,
                "reasoning": "Brent crude dropped 12%",
                "summary": "Oil crash detected",
                "actions": [{"type": "alert_owner", "body": "Brent -12%"}],
            }),
            tool_calls=[],
        )
        mock_provider.complete = AsyncMock(side_effect=[tool_response, final_response])
        mock_provider.response_as_message.return_value = {"role": "assistant", "content": []}
        mock_provider.tool_results_as_message.return_value = {"role": "user", "content": "result"}

        search_tool = MagicMock(spec=Tool)
        search_tool.name = "web_search"
        search_tool.run = AsyncMock(return_value="Brent crude: $72.50, down 12.3%")

        engine = JudgmentEngine(provider=mock_provider, tools=[search_tool])
        result = await engine.judge("watch oil", [])

        assert result.should_act is True
        assert result.summary == "Oil crash detected"
        assert mock_provider.complete.call_count == 2  # 1 tool call + 1 final answer
        search_tool.run.assert_called_once_with(query="oil price")

    async def test_unknown_tool_handled_gracefully(self, mock_provider):
        """Unknown tool name should return error string, not raise."""
        tool_response = ProviderResponse(
            text=None,
            tool_calls=[ToolCall(id="c1", name="nonexistent_tool", arguments={})],
        )
        final_response = ProviderResponse(
            text=json.dumps({
                "should_act": False, "reasoning": "ok", "summary": "ok", "actions": []
            }),
        )
        mock_provider.complete = AsyncMock(side_effect=[tool_response, final_response])
        mock_provider.response_as_message.return_value = {}
        mock_provider.tool_results_as_message.return_value = {}

        engine = JudgmentEngine(provider=mock_provider, tools=[])
        result = await engine.judge("test", [])
        assert result.error is None  # should not crash

    async def test_provider_error_returns_error_result(self, mock_provider):
        mock_provider.complete = AsyncMock(side_effect=RuntimeError("API down"))
        engine = JudgmentEngine(provider=mock_provider, tools=[])
        result = await engine.judge("test", [])
        assert result.should_act is False
        assert result.error is not None


# ── parse_action ──────────────────────────────────────────────────────────────


class TestParseAction:
    def test_send_message(self):
        a = parse_action({"type": "send_message", "to_did": "did:x", "body": "hi"})
        assert isinstance(a, SendMessageAction)

    def test_find_and_contact(self):
        a = parse_action({"type": "find_and_contact", "capability": "hedge", "body": "help", "max_agents": 2})
        assert isinstance(a, FindAndContactAction)
        assert a.max_agents == 2

    def test_alert_owner(self):
        a = parse_action({"type": "alert_owner", "body": "urgent"})
        assert isinstance(a, AlertOwnerAction)

    def test_store_note(self):
        a = parse_action({"type": "store_note", "key": "k", "value": "v"})
        assert isinstance(a, StoreNoteAction)

    def test_unknown(self):
        assert parse_action({"type": "unknown"}) is None


# ── Triggers ──────────────────────────────────────────────────────────────────


class TestIntervalTrigger:
    def test_minimum(self):
        with pytest.raises(ValueError):
            IntervalTrigger(seconds=5)

    async def test_sleeps(self):
        t = IntervalTrigger(seconds=10)
        with patch("asyncio.sleep", new_callable=AsyncMock) as s:
            await t.wait_until_next()
            s.assert_called_once_with(10)


class TestOnChangeTrigger:
    def test_minimum_poll(self):
        p = MagicMock(spec=Perception)
        p.name = "x"
        with pytest.raises(ValueError):
            OnChangeTrigger(p, poll_interval=5)

    async def test_fires_on_change(self):
        mock_p = MagicMock(spec=Perception)
        mock_p.name = "mock"
        call_count = 0

        async def fake_read(last_state=None):
            nonlocal call_count
            call_count += 1
            return PerceptionData(
                source="mock", content="data",
                changed=(call_count >= 2), state_token=f"tok{call_count}",
            )

        mock_p.read = fake_read
        t = OnChangeTrigger(mock_p, poll_interval=10)
        with patch("asyncio.sleep", new_callable=AsyncMock):
            await t.wait_until_next()
        assert call_count == 2

    async def test_fire_on_first(self):
        mock_p = MagicMock(spec=Perception)
        mock_p.name = "mock"
        mock_p.read = AsyncMock(return_value=PerceptionData(
            source="mock", content="data", changed=False, state_token="tok1"
        ))
        t = OnChangeTrigger(mock_p, poll_interval=10, fire_on_first=True)
        with patch("asyncio.sleep", new_callable=AsyncMock):
            await t.wait_until_next()
        mock_p.read.assert_called_once()


# ── AgentBrain integration ────────────────────────────────────────────────────


class TestAgentBrain:
    def test_provider_required(self, tmp_path, monkeypatch):
        import agentid.brain.memory.store as m
        monkeypatch.setattr(m, "BRAIN_DIR", tmp_path / "brain")
        with pytest.raises(TypeError):
            AgentBrain(agent_did="did:x", api_key="k", mission="test")  # missing provider

    def test_repr(self, brain):
        r = repr(brain)
        assert "mock" in r
        assert "did:agentid:test" in r

    def test_fluent_add(self, brain):
        mock_p = MagicMock(spec=Perception)
        mock_p.name = "src"
        brain.add_perception(mock_p).add_trigger(IntervalTrigger(seconds=10))
        assert len(brain._perceptions) == 1
        assert len(brain._triggers) == 1

    def test_tool_string_shorthand(self, tmp_path, monkeypatch, mock_provider):
        import agentid.brain.memory.store as m
        monkeypatch.setattr(m, "BRAIN_DIR", tmp_path / "brain")
        brain = AgentBrain(
            agent_did="did:x", api_key="k", mission="test",
            provider=mock_provider,
            tools=["web_search", "fetch_url"],
        )
        names = {t.name for t in brain._judgment._tools}
        assert "web_search" in names
        assert "fetch_url" in names

    def test_unknown_tool_string_raises(self, tmp_path, monkeypatch, mock_provider):
        import agentid.brain.memory.store as m
        monkeypatch.setattr(m, "BRAIN_DIR", tmp_path / "brain")
        with pytest.raises(ValueError, match="Unknown built-in tool"):
            AgentBrain(
                agent_did="did:x", api_key="k", mission="test",
                provider=mock_provider,
                tools=["nonexistent"],
            )

    async def test_think_once_no_action(self, brain):
        """should_act=False → no HTTP calls to AgentID."""
        await brain.think_once()
        brain._judgment._provider.complete.assert_called_once()

    async def test_think_once_store_note_action(self, brain):
        """should_act=True with store_note → note written to memory."""
        brain._judgment._provider.complete = AsyncMock(
            return_value=ProviderResponse(
                text=json.dumps({
                    "should_act": True,
                    "reasoning": "test",
                    "summary": "test",
                    "actions": [{"type": "store_note", "key": "test_key", "value": "test_val"}],
                })
            )
        )
        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.send_message = AsyncMock()

        with patch("agentid.runtime.client.AsyncAgentIDClient", return_value=mock_client):
            await brain.think_once()

        assert brain.memory.get_note("test_key") == "test_val"

    async def test_run_stops_on_stop(self, brain):
        brain.add_trigger(IntervalTrigger(seconds=10))

        async def stop_soon():
            await asyncio.sleep(0.05)
            brain.stop()

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await asyncio.gather(brain.run(), stop_soon(), return_exceptions=True)

        assert brain._running is False


# ── FilePerception ────────────────────────────────────────────────────────────


class TestFilePerception:
    async def test_reads_content(self, tmp_path):
        f = tmp_path / "data.txt"
        f.write_text("hello world")
        p = FilePerception(path=str(f))
        data = await p.read()
        assert "hello world" in data.content
        assert "file" in data.source

    async def test_detects_change(self, tmp_path):
        f = tmp_path / "data.txt"
        f.write_text("original")
        p = FilePerception(path=str(f))
        first = await p.read()
        f.write_text("modified")
        second = await p.read(last_state=first.state_token)
        assert second.changed is True

    async def test_no_change(self, tmp_path):
        f = tmp_path / "data.txt"
        f.write_text("same")
        p = FilePerception(path=str(f))
        first = await p.read()
        second = await p.read(last_state=first.state_token)
        assert second.changed is False
