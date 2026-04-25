"""
Tests for the LangChain integration.

Tests the callback handler and tools independently of a real LLM —
no API key or network required.
"""

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from agentid import Agent
from agentid.integrations.langchain import (
    AgentIDCallbackHandler,
    AgentIDFindTool,
    AgentIDVerifyTool,
    AgentIDSignTool,
    verify_langchain_output,
)


# ── AgentIDCallbackHandler ────────────────────────────────────────────────────

def test_callback_handler_creates_agent(tmp_path):
    handler = AgentIDCallbackHandler(
        name="test-handler",
        capabilities=["summarization"],
        owner="test@x.com",
        registry_path=str(tmp_path),
    )
    assert handler.did.startswith("did:agentid:")
    assert handler.agent.name == "test-handler"


def test_callback_handler_signs_output(tmp_path):
    handler = AgentIDCallbackHandler(
        name="signing-handler",
        capabilities=["ops"],
        owner="test@x.com",
        registry_path=str(tmp_path),
    )

    # Simulate AgentFinish
    finish = MagicMock()
    finish.return_values = {"output": "The answer is 42."}
    handler.on_agent_finish(finish)

    assert "_agentid_did" in finish.return_values
    assert "_agentid_signature" in finish.return_values
    assert finish.return_values["_agentid_did"] == handler.did


def test_callback_handler_registers_in_registry(tmp_path):
    handler = AgentIDCallbackHandler(
        name="registered-handler",
        capabilities=["search"],
        owner="test@x.com",
        registry_path=str(tmp_path),
    )
    resolved = Agent.resolve(handler.did, registry_path=str(tmp_path))
    assert resolved is not None
    assert resolved.name == "registered-handler"


def test_on_agent_action_does_not_raise(tmp_path):
    handler = AgentIDCallbackHandler(
        name="action-handler",
        capabilities=["ops"],
        owner="test@x.com",
        registry_path=str(tmp_path),
    )
    action = MagicMock()
    action.tool = "web-search"
    handler.on_agent_action(action)  # should not raise


# ── AgentIDFindTool ───────────────────────────────────────────────────────────

def test_find_tool_returns_matching_agents(tmp_path):
    Agent.create("finder-a", ["web-search", "summarization"], "u@x.com", registry_path=str(tmp_path))
    Agent.create("finder-b", ["code-review"], "u@x.com", registry_path=str(tmp_path))

    tool = AgentIDFindTool(registry_path=str(tmp_path))
    result = tool._run("web-search")

    agents = json.loads(result)
    names = [a["name"] for a in agents]
    assert "finder-a" in names
    assert "finder-b" not in names


def test_find_tool_returns_message_when_none_found(tmp_path):
    tool = AgentIDFindTool(registry_path=str(tmp_path))
    result = tool._run("nonexistent-capability")
    assert "No agents found" in result


def test_find_tool_result_has_required_fields(tmp_path):
    Agent.create("field-test", ["translation"], "u@x.com", registry_path=str(tmp_path))
    tool = AgentIDFindTool(registry_path=str(tmp_path))
    result = json.loads(tool._run("translation"))

    assert len(result) > 0
    agent = result[0]
    assert "did" in agent
    assert "name" in agent
    assert "capabilities" in agent
    assert "owner" in agent


# ── AgentIDVerifyTool ─────────────────────────────────────────────────────────

def test_verify_tool_valid_signature(tmp_path):
    agent = Agent.create("verify-source", ["ops"], "u@x.com", registry_path=str(tmp_path))
    signed = agent.sign({"task": "deploy service"})

    tool = AgentIDVerifyTool(registry_path=str(tmp_path))
    result = json.loads(tool._run(json.dumps(signed)))

    assert result["valid"] is True
    assert result["signer"] == agent.did


def test_verify_tool_tampered_message(tmp_path):
    agent = Agent.create("tamper-source", ["ops"], "u@x.com", registry_path=str(tmp_path))
    signed = agent.sign({"task": "deploy"})

    tampered = {"payload": {**signed["payload"], "task": "destroy"}, "signature": signed["signature"]}

    tool = AgentIDVerifyTool(registry_path=str(tmp_path))
    result = json.loads(tool._run(json.dumps(tampered)))

    assert result["valid"] is False


def test_verify_tool_invalid_json(tmp_path):
    tool = AgentIDVerifyTool(registry_path=str(tmp_path))
    result = tool._run("not json at all")
    assert "Invalid input" in result


def test_verify_tool_missing_keys(tmp_path):
    tool = AgentIDVerifyTool(registry_path=str(tmp_path))
    result = tool._run(json.dumps({"only": "one key"}))
    assert "Invalid input" in result


# ── AgentIDSignTool ───────────────────────────────────────────────────────────

def test_sign_tool_produces_verifiable_output(tmp_path):
    agent = Agent.create("sign-tool-agent", ["ops"], "u@x.com", registry_path=str(tmp_path))
    tool = AgentIDSignTool(agent=agent)

    result = json.loads(tool._run(json.dumps({"result": "task complete"})))

    assert "payload" in result
    assert "signature" in result
    assert result["payload"]["signer"] == agent.did

    valid = Agent.verify_from_did(result, registry_path=str(tmp_path))
    assert valid


def test_sign_tool_accepts_plain_string(tmp_path):
    agent = Agent.create("sign-plain", ["ops"], "u@x.com", registry_path=str(tmp_path))
    tool = AgentIDSignTool(agent=agent)

    result = json.loads(tool._run("plain text message"))
    assert "payload" in result
    assert result["payload"]["message"] == "plain text message"


# ── verify_langchain_output ───────────────────────────────────────────────────

def test_verify_langchain_output_valid(tmp_path):
    handler = AgentIDCallbackHandler(
        name="output-verifier",
        capabilities=["ops"],
        owner="test@x.com",
        registry_path=str(tmp_path),
    )

    finish = MagicMock()
    finish.return_values = {"output": "Task completed successfully."}
    handler.on_agent_finish(finish)

    result = finish.return_values
    assert verify_langchain_output(result, registry_path=str(tmp_path))


def test_verify_langchain_output_missing_fields(tmp_path):
    result = {"output": "something but no signature"}
    assert not verify_langchain_output(result, registry_path=str(tmp_path))
