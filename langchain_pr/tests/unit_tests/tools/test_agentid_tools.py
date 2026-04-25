"""Unit tests for AgentID LangChain tools."""

import json
from unittest.mock import MagicMock, patch
import pytest


@pytest.fixture
def mock_agent_doc():
    doc = MagicMock()
    doc.did = "did:agentid:abc123"
    doc.name = "search-agent"
    doc.capabilities = ["web-search"]
    doc.owner = "team@example.com"
    return doc


# ── AgentIDFindTool ───────────────────────────────────────────────────────────

def test_find_tool_returns_agents(mock_agent_doc):
    with patch("agentid.Agent.find", return_value=[mock_agent_doc]):
        from langchain_community.tools.agentid.tool import AgentIDFindTool
        tool = AgentIDFindTool()
        result = json.loads(tool._run("web-search"))

    assert len(result) == 1
    assert result[0]["did"] == mock_agent_doc.did
    assert result[0]["name"] == mock_agent_doc.name
    assert "web-search" in result[0]["capabilities"]


def test_find_tool_no_results():
    with patch("agentid.Agent.find", return_value=[]):
        from langchain_community.tools.agentid.tool import AgentIDFindTool
        tool = AgentIDFindTool()
        result = tool._run("nonexistent-capability")

    assert "No agents found" in result


def test_find_tool_schema():
    from langchain_community.tools.agentid.tool import AgentIDFindTool
    tool = AgentIDFindTool()
    assert tool.name == "agentid_find"
    assert "capability" in tool.description


# ── AgentIDVerifyTool ─────────────────────────────────────────────────────────

def test_verify_tool_valid():
    signed = {
        "payload": {"output": "result", "signer": "did:agentid:abc", "nonce": "x"},
        "signature": "validsig==",
    }
    with patch("agentid.Agent.verify_from_did", return_value=True):
        from langchain_community.tools.agentid.tool import AgentIDVerifyTool
        tool = AgentIDVerifyTool()
        result = json.loads(tool._run(json.dumps(signed)))

    assert result["valid"] is True
    assert "valid" in result["message"].lower()


def test_verify_tool_invalid_signature():
    signed = {
        "payload": {"output": "tampered", "signer": "did:agentid:abc"},
        "signature": "badsig==",
    }
    with patch("agentid.Agent.verify_from_did", return_value=False):
        from langchain_community.tools.agentid.tool import AgentIDVerifyTool
        tool = AgentIDVerifyTool()
        result = json.loads(tool._run(json.dumps(signed)))

    assert result["valid"] is False
    assert "INVALID" in result["message"]


def test_verify_tool_bad_json():
    from langchain_community.tools.agentid.tool import AgentIDVerifyTool
    tool = AgentIDVerifyTool()
    result = tool._run("not valid json {{{")
    assert "Invalid input" in result


def test_verify_tool_missing_keys():
    from langchain_community.tools.agentid.tool import AgentIDVerifyTool
    tool = AgentIDVerifyTool()
    result = tool._run(json.dumps({"only": "one key"}))
    assert "Invalid input" in result


# ── AgentIDSignTool ───────────────────────────────────────────────────────────

def test_sign_tool_json_input():
    mock_agent = MagicMock()
    mock_agent.sign.return_value = {
        "payload": {"result": "done", "signer": "did:agentid:abc"},
        "signature": "sig==",
    }
    from langchain_community.tools.agentid.tool import AgentIDSignTool
    tool = AgentIDSignTool(agent=mock_agent)
    result = json.loads(tool._run(json.dumps({"result": "done"})))

    mock_agent.sign.assert_called_once_with({"result": "done"})
    assert "payload" in result
    assert "signature" in result


def test_sign_tool_plain_string_input():
    mock_agent = MagicMock()
    mock_agent.sign.return_value = {"payload": {"message": "hello"}, "signature": "sig=="}
    from langchain_community.tools.agentid.tool import AgentIDSignTool
    tool = AgentIDSignTool(agent=mock_agent)
    tool._run("hello world")

    mock_agent.sign.assert_called_once_with({"message": "hello world"})


# ── verify_langchain_output ───────────────────────────────────────────────────

def test_verify_langchain_output_valid():
    result = {
        "output": "The answer.",
        "_agentid_payload": {"output": "The answer.", "signer": "did:agentid:abc"},
        "_agentid_signature": "sig==",
        "_agentid_did": "did:agentid:abc",
    }
    with patch("agentid.Agent.verify_from_did", return_value=True):
        from langchain_community.tools.agentid.tool import verify_langchain_output
        assert verify_langchain_output(result) is True


def test_verify_langchain_output_missing_fields():
    from langchain_community.tools.agentid.tool import verify_langchain_output
    assert verify_langchain_output({"output": "no signature here"}) is False


def test_verify_langchain_output_empty():
    from langchain_community.tools.agentid.tool import verify_langchain_output
    assert verify_langchain_output({}) is False
