"""Unit tests for AgentIDCallbackHandler."""

from unittest.mock import MagicMock, patch
import pytest


@pytest.fixture
def mock_agent():
    agent = MagicMock()
    agent.did = "did:agentid:testkey123"
    agent.name = "test-agent"
    agent.sign.return_value = {
        "payload": {"output": "result", "signer": "did:agentid:testkey123", "nonce": "abc"},
        "signature": "fakesig==",
    }
    return agent


@pytest.fixture
def handler(mock_agent, tmp_path):
    with patch("agentid.Agent.create", return_value=mock_agent):
        from langchain_community.callbacks.agentid_callback import AgentIDCallbackHandler
        return AgentIDCallbackHandler(
            name="test-agent",
            capabilities=["search"],
            owner="test@example.com",
            registry_path=str(tmp_path),
        )


def test_did_property(handler, mock_agent):
    assert handler.did == mock_agent.did


def test_agent_property(handler, mock_agent):
    assert handler.agent is mock_agent


def test_on_agent_finish_signs_output(handler, mock_agent):
    finish = MagicMock()
    finish.return_values = {"output": "The answer is 42."}
    handler.on_agent_finish(finish)

    mock_agent.sign.assert_called_once()
    assert "_agentid_did" in finish.return_values
    assert "_agentid_signature" in finish.return_values
    assert "_agentid_payload" in finish.return_values
    assert finish.return_values["_agentid_did"] == mock_agent.did


def test_on_agent_finish_empty_output(handler, mock_agent):
    finish = MagicMock()
    finish.return_values = {}
    handler.on_agent_finish(finish)
    mock_agent.sign.assert_called_once_with({"output": ""})


def test_on_agent_action_does_not_raise(handler):
    action = MagicMock()
    action.tool = "web-search"
    handler.on_agent_action(action)


def test_on_chain_error_does_not_raise(handler):
    handler.on_chain_error(ValueError("something broke"))


def test_missing_agentid_raises_import_error(tmp_path):
    import sys
    with patch.dict(sys.modules, {"agentid": None}):
        from importlib import import_module
        import importlib
        # Re-import to trigger the ImportError path
        with pytest.raises(ImportError, match="pip install agentid"):
            import importlib.util
            spec = importlib.util.spec_from_file_location(
                "agentid_callback",
                "langchain_community/callbacks/agentid_callback.py",
            )
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            mod.AgentIDCallbackHandler(
                name="x", capabilities=[], owner="x@x.com"
            )
