"""
Tests for agentid.brain — AgentBrain, triggers, perception, judgment, actions.
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ── Imports ────────────────────────────────────────────────────────────────────

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
)
from agentid.brain.perception.base import Perception, PerceptionData


# ── Fixtures ───────────────────────────────────────────────────────────────────


@pytest.fixture
def tmp_did(tmp_path):
    """A fake DID that uses a temp directory for BrainMemory."""
    return f"did:agentid:test_{tmp_path.name}"


@pytest.fixture
def memory(tmp_did, tmp_path, monkeypatch):
    """BrainMemory using a temp directory."""
    import agentid.brain.memory.store as store_mod
    monkeypatch.setattr(store_mod, "BRAIN_DIR", tmp_path / "brain")
    return BrainMemory(tmp_did)


# ── BrainMemory tests ──────────────────────────────────────────────────────────


class TestBrainMemory:
    def test_empty_state(self, memory):
        assert memory.get_perception_state("git:repo") is None

    def test_set_get_perception_state(self, memory):
        memory.set_perception_state("git:repo", "abc123")
        assert memory.get_perception_state("git:repo") == "abc123"

    def test_record_and_recent_history(self, memory):
        memory.record_action("send_message", "→ did:agentid:bob: hello")
        history = memory.recent_history(1)
        assert len(history) == 1
        assert history[0]["type"] == "send_message"
        assert "bob" in history[0]["detail"]

    def test_notes_roundtrip(self, memory):
        memory.set_note("owner_did", "did:agentid:alice")
        assert memory.get_note("owner_did") == "did:agentid:alice"

    def test_history_capped_at_200(self, memory):
        for i in range(250):
            memory.record_action("test", f"item {i}")
        assert len(memory._data["history"]) == 200

    def test_get_context_no_history(self, memory):
        ctx = memory.get_context()
        assert ctx == "No prior history."

    def test_get_context_with_history(self, memory):
        memory.record_action("send_message", "→ bob: hello")
        memory.set_note("key", "value")
        ctx = memory.get_context()
        assert "send_message" in ctx
        assert "key" in ctx


# ── IntervalTrigger tests ──────────────────────────────────────────────────────


class TestIntervalTrigger:
    def test_minimum_seconds(self):
        with pytest.raises(ValueError, match="minimum interval"):
            IntervalTrigger(seconds=5)

    def test_repr(self):
        t = IntervalTrigger(seconds=60)
        assert "60" in repr(t)

    async def test_wait_calls_sleep(self):
        t = IntervalTrigger(seconds=10)
        with patch("asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            await t.wait_until_next()
            mock_sleep.assert_called_once_with(10)


# ── DailyTrigger tests ─────────────────────────────────────────────────────────


class TestDailyTrigger:
    def test_invalid_hour(self):
        with pytest.raises(ValueError):
            DailyTrigger(hour=24)

    def test_invalid_minute(self):
        with pytest.raises(ValueError):
            DailyTrigger(minute=60)

    def test_repr(self):
        t = DailyTrigger(hour=9, minute=30)
        assert "9" in repr(t)
        assert "30" in repr(t)
        assert "UTC" in repr(t)

    def test_name(self):
        t = DailyTrigger(hour=9, minute=0)
        assert "09:00" in t._name


# ── OnChangeTrigger tests ──────────────────────────────────────────────────────


class TestOnChangeTrigger:
    def test_minimum_poll_interval(self):
        mock_p = MagicMock(spec=Perception)
        mock_p.name = "test"
        with pytest.raises(ValueError, match="minimum poll_interval"):
            OnChangeTrigger(mock_p, poll_interval=5)

    def test_repr(self):
        mock_p = MagicMock(spec=Perception)
        mock_p.name = "api:test"
        t = OnChangeTrigger(mock_p, poll_interval=30)
        assert "api:test" in repr(t)
        assert "30" in repr(t)

    async def test_fires_on_change(self):
        """Trigger should return as soon as perception reports changed=True."""
        mock_p = MagicMock(spec=Perception)
        mock_p.name = "mock"

        call_count = 0

        async def fake_read(last_state=None):
            nonlocal call_count
            call_count += 1
            # First call: unchanged (baseline). Second call: changed.
            changed = call_count >= 2
            return PerceptionData(
                source="mock",
                content="data",
                changed=changed,
                state_token=f"tok{call_count}",
            )

        mock_p.read = fake_read
        t = OnChangeTrigger(mock_p, poll_interval=10)

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await t.wait_until_next()

        assert call_count == 2  # baseline + one changed read

    async def test_fire_on_first(self):
        """With fire_on_first=True, trigger should fire on the very first read."""
        mock_p = MagicMock(spec=Perception)
        mock_p.name = "mock"

        async def fake_read(last_state=None):
            return PerceptionData(
                source="mock",
                content="data",
                changed=False,   # explicit unchanged — but fire_on_first=True
                state_token="tok1",
            )

        mock_p.read = fake_read
        t = OnChangeTrigger(mock_p, poll_interval=10, fire_on_first=True)

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await t.wait_until_next()  # should return immediately


# ── FilePerception tests ───────────────────────────────────────────────────────


class TestFilePerception:
    async def test_reads_file_content(self, tmp_path):
        f = tmp_path / "data.txt"
        f.write_text("hello world")
        p = FilePerception(path=str(f))
        data = await p.read()
        assert "hello world" in data.content
        assert "file" in data.source
        assert data.state_token  # checksum present

    async def test_detects_change(self, tmp_path):
        f = tmp_path / "data.txt"
        f.write_text("original")
        p = FilePerception(path=str(f))

        first = await p.read()
        f.write_text("modified content")
        second = await p.read(last_state=first.state_token)

        assert second.changed is True

    async def test_unchanged_when_same(self, tmp_path):
        f = tmp_path / "data.txt"
        f.write_text("same content")
        p = FilePerception(path=str(f))

        first = await p.read()
        second = await p.read(last_state=first.state_token)

        assert second.changed is False

    async def test_missing_file(self, tmp_path):
        p = FilePerception(path=str(tmp_path / "nonexistent.txt"))
        data = await p.read()
        assert data.changed is False
        assert data.content == "" or "not found" in data.content.lower()


# ── APIPerception tests ────────────────────────────────────────────────────────


class TestAPIPerception:
    async def test_reads_endpoint(self):
        p = APIPerception(url="https://httpbin.org/get")
        import httpx
        mock_resp = MagicMock()
        mock_resp.text = '{"origin": "1.2.3.4"}'
        mock_resp.status_code = 200
        mock_resp.is_success = True
        mock_resp.headers = {}

        with patch("httpx.AsyncClient") as MockClient:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client.request = AsyncMock(return_value=mock_resp)
            MockClient.return_value = mock_client

            data = await p.read()

        assert "1.2.3.4" in data.content or data.state_token

    async def test_detects_change_on_diff_response(self):
        p = APIPerception(url="https://example.com/api")

        import httpx

        async def make_mock_resp(text):
            mock_resp = MagicMock()
            mock_resp.text = text
            mock_resp.status_code = 200
            mock_resp.is_success = True
            mock_resp.headers = {}
            return mock_resp

        with patch("httpx.AsyncClient") as MockClient:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client.request = AsyncMock(
                side_effect=[
                    await make_mock_resp('{"status": "ok"}'),
                    await make_mock_resp('{"status": "degraded"}'),
                ]
            )
            MockClient.return_value = mock_client

            first = await p.read()
            second = await p.read(last_state=first.state_token)

        assert second.changed is True


# ── parse_action tests ─────────────────────────────────────────────────────────


class TestParseAction:
    def test_send_message(self):
        action = parse_action({"type": "send_message", "to_did": "did:x", "body": "hi"})
        assert isinstance(action, SendMessageAction)
        assert action.to_did == "did:x"
        assert action.body == "hi"

    def test_find_and_contact(self):
        action = parse_action({
            "type": "find_and_contact",
            "capability": "security-audit",
            "body": "please review",
            "max_agents": 2,
        })
        assert isinstance(action, FindAndContactAction)
        assert action.capability == "security-audit"
        assert action.max_agents == 2

    def test_alert_owner(self):
        action = parse_action({"type": "alert_owner", "body": "urgent!"})
        assert isinstance(action, AlertOwnerAction)
        assert action.body == "urgent!"

    def test_store_note(self):
        action = parse_action({"type": "store_note", "key": "k", "value": "v"})
        assert isinstance(action, StoreNoteAction)
        assert action.key == "k"

    def test_unknown_type(self):
        action = parse_action({"type": "unknown_action"})
        assert action is None


# ── JudgmentEngine tests ───────────────────────────────────────────────────────


class TestJudgmentEngine:
    def test_requires_at_least_one_key(self):
        with pytest.raises(ValueError, match="at least one"):
            JudgmentEngine()

    async def test_uses_anthropic_first(self):
        """When Anthropic key is set, it should be called first."""
        engine = JudgmentEngine(anthropic_key="sk-ant-fake", openai_key="sk-fake")

        good_response = json.dumps({
            "should_act": True,
            "reasoning": "code changed",
            "summary": "New commit detected",
            "actions": [{"type": "alert_owner", "body": "new commit"}],
        })

        mock_resp = MagicMock()
        mock_resp.is_success = True
        mock_resp.json.return_value = {
            "content": [{"type": "text", "text": good_response}]
        }

        perceptions = [
            PerceptionData(
                source="git:repo",
                content="diff --git a/main.py ...",
                changed=True,
                state_token="abc123",
            )
        ]

        with patch("httpx.AsyncClient") as MockClient:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client.post = AsyncMock(return_value=mock_resp)
            MockClient.return_value = mock_client

            result = await engine.judge("Watch the repo", perceptions)

        assert result.should_act is True
        assert result.summary == "New commit detected"
        assert len(result.raw_actions) == 1

    async def test_falls_back_to_openai(self):
        """Anthropic failure should fall back to OpenAI."""
        engine = JudgmentEngine(anthropic_key="sk-ant-fake", openai_key="sk-fake")

        openai_response = json.dumps({
            "should_act": False,
            "reasoning": "nothing changed",
            "summary": "All quiet",
            "actions": [],
        })

        anthropic_fail = MagicMock()
        anthropic_fail.is_success = False
        anthropic_fail.status_code = 500
        anthropic_fail.text = "Internal Server Error"

        openai_ok = MagicMock()
        openai_ok.is_success = True
        openai_ok.json.return_value = {
            "choices": [{"message": {"content": openai_response}}]
        }

        perceptions = [
            PerceptionData(source="api:test", content="{}", changed=False, state_token="x")
        ]

        call_count = 0

        async def fake_post(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            return anthropic_fail if call_count == 1 else openai_ok

        with patch("httpx.AsyncClient") as MockClient:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client.post = fake_post
            MockClient.return_value = mock_client

            result = await engine.judge("Watch something", perceptions)

        assert result.should_act is False
        assert result.summary == "All quiet"


# ── AgentBrain integration tests ───────────────────────────────────────────────


class TestAgentBrain:
    def test_requires_llm_key(self):
        with pytest.raises(ValueError, match="at least one"):
            AgentBrain(
                agent_did="did:agentid:test",
                api_key="key",
                mission="test",
            )

    def test_fluent_api(self, tmp_path, monkeypatch):
        import agentid.brain.memory.store as store_mod
        monkeypatch.setattr(store_mod, "BRAIN_DIR", tmp_path / "brain")

        mock_p = MagicMock(spec=Perception)
        mock_p.name = "mock"
        t = IntervalTrigger(seconds=10)

        brain = (
            AgentBrain(
                agent_did="did:agentid:test",
                api_key="k",
                mission="test",
                anthropic_key="sk-ant-x",
            )
            .add_perception(mock_p)
            .add_trigger(t)
        )
        assert len(brain._perceptions) == 1
        assert len(brain._triggers) == 1

    async def test_think_once_no_action(self, tmp_path, monkeypatch):
        """When judgment says should_act=False, no actions are executed."""
        import agentid.brain.memory.store as store_mod
        monkeypatch.setattr(store_mod, "BRAIN_DIR", tmp_path / "brain")

        brain = AgentBrain(
            agent_did="did:agentid:test",
            api_key="k",
            mission="test",
            anthropic_key="sk-ant-x",
        )

        # Add a simple perception
        mock_p = MagicMock(spec=Perception)
        mock_p.name = "mock"
        mock_p.read = AsyncMock(return_value=PerceptionData(
            source="mock", content="data", changed=True, state_token="tok1"
        ))
        brain.add_perception(mock_p)

        # Mock judgment to return should_act=False
        mock_result = JudgmentResult(
            should_act=False,
            reasoning="nothing important",
            summary="All quiet",
        )
        brain._judgment.judge = AsyncMock(return_value=mock_result)

        # Should complete without calling the API
        await brain.think_once()

        mock_p.read.assert_called_once()
        brain._judgment.judge.assert_called_once()

    async def test_think_once_with_action(self, tmp_path, monkeypatch):
        """When judgment says should_act=True, actions should be executed."""
        import agentid.brain.memory.store as store_mod
        monkeypatch.setattr(store_mod, "BRAIN_DIR", tmp_path / "brain")

        brain = AgentBrain(
            agent_did="did:agentid:test",
            api_key="k",
            mission="test",
            anthropic_key="sk-ant-x",
        )

        mock_p = MagicMock(spec=Perception)
        mock_p.name = "mock"
        mock_p.read = AsyncMock(return_value=PerceptionData(
            source="mock", content="critical bug", changed=True, state_token="tok1"
        ))
        brain.add_perception(mock_p)

        mock_result = JudgmentResult(
            should_act=True,
            reasoning="bug detected",
            summary="Critical bug in main.py",
            raw_actions=[{"type": "store_note", "key": "last_bug", "value": "main.py:42"}],
        )
        brain._judgment.judge = AsyncMock(return_value=mock_result)

        # Mock AsyncAgentIDClient so no real HTTP is made
        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.send_message = AsyncMock()

        with patch("agentid.runtime.client.AsyncAgentIDClient", return_value=mock_client):
            await brain.think_once()

        # store_note should have written to memory
        assert brain.memory.get_note("last_bug") == "main.py:42"

    async def test_run_stops_on_stop_call(self, tmp_path, monkeypatch):
        """brain.stop() should cause run() to exit cleanly."""
        import agentid.brain.memory.store as store_mod
        monkeypatch.setattr(store_mod, "BRAIN_DIR", tmp_path / "brain")

        brain = AgentBrain(
            agent_did="did:agentid:test",
            api_key="k",
            mission="test",
            anthropic_key="sk-ant-x",
        )

        # Use a very short interval trigger so it fires quickly
        brain.add_trigger(IntervalTrigger(seconds=10))
        brain._judgment.judge = AsyncMock(return_value=JudgmentResult(
            should_act=False, reasoning="", summary="quiet"
        ))

        async def _stop_after_short_delay():
            await asyncio.sleep(0.1)
            brain.stop()

        with patch("asyncio.sleep", new_callable=AsyncMock):
            # Run brain and stop it almost immediately
            await asyncio.gather(
                brain.run(),
                _stop_after_short_delay(),
                return_exceptions=True,
            )

        assert brain._running is False
