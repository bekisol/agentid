"""Tests for AutoGen AgentID integration."""

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / "sdk" / "python"))

from autogen_agentid.verify import (
    extract_signed_payload,
    verify_autogen_message,
    strip_signature,
)

_SEPARATOR = "\n\n---agentid---\n"


# ── extract_signed_payload ────────────────────────────────────────────────────

def test_extract_no_signature():
    content, envelope = extract_signed_payload("Hello, how can I help?")
    assert content == "Hello, how can I help?"
    assert envelope is None


def test_extract_with_signature():
    envelope_data = {"did": "did:agentid:abc", "payload": {"content": "Hello"}, "signature": "sig=="}
    raw = f"Hello{_SEPARATOR}{json.dumps(envelope_data)}"
    content, envelope = extract_signed_payload(raw)
    assert content == "Hello"
    assert envelope["did"] == "did:agentid:abc"


def test_extract_malformed_envelope():
    raw = f"Hello{_SEPARATOR}not valid json {{{{"
    content, envelope = extract_signed_payload(raw)
    assert content == "Hello"
    assert envelope is None


# ── strip_signature ───────────────────────────────────────────────────────────

def test_strip_signature_removes_envelope():
    raw = f"The answer is 42{_SEPARATOR}{{\"did\":\"did:agentid:x\"}}"
    assert strip_signature(raw) == "The answer is 42"


def test_strip_signature_passthrough():
    assert strip_signature("plain message") == "plain message"


# ── verify_autogen_message ────────────────────────────────────────────────────

def test_verify_valid_message(tmp_path):
    from agentid import Agent

    agent = Agent.create("verifier-agent", ["ops"], "u@x.com", registry_path=str(tmp_path))
    signed = agent.sign({"content": "Hello from agent", "agent_name": "verifier-agent"})
    envelope = json.dumps({"did": agent.did, **signed}, separators=(",", ":"))
    raw = f"Hello from agent{_SEPARATOR}{envelope}"

    assert verify_autogen_message(raw, registry_path=str(tmp_path))


def test_verify_no_signature(tmp_path):
    assert not verify_autogen_message("plain message", registry_path=str(tmp_path))


def test_verify_tampered_message(tmp_path):
    from agentid import Agent

    agent = Agent.create("tamper-agent", ["ops"], "u@x.com", registry_path=str(tmp_path))
    signed = agent.sign({"content": "original", "agent_name": "tamper-agent"})

    tampered_signed = {**signed, "payload": {**signed["payload"], "content": "hacked"}}
    envelope = json.dumps({"did": agent.did, **tampered_signed}, separators=(",", ":"))
    raw = f"original{_SEPARATOR}{envelope}"

    assert not verify_autogen_message(raw, registry_path=str(tmp_path))


# ── AgentIDMixin ──────────────────────────────────────────────────────────────

def test_agentid_mixin_registers_agent(tmp_path):
    from autogen import ConversableAgent
    from autogen_agentid.agent import AgentIDMixin

    class TestAgent(AgentIDMixin, ConversableAgent):
        pass

    agent = TestAgent(
        "test-mixin",
        agentid_capabilities=["search"],
        agentid_owner="u@x.com",
        agentid_registry_path=str(tmp_path),
        llm_config=False,
        human_input_mode="NEVER",
    )

    assert agent.agentid_did.startswith("did:agentid:")
    assert agent.agentid.name == "test-mixin"


def test_agentid_mixin_sign_content(tmp_path):
    from autogen import ConversableAgent
    from autogen_agentid.agent import AgentIDMixin

    class TestAgent(AgentIDMixin, ConversableAgent):
        pass

    agent = TestAgent(
        "signer",
        agentid_capabilities=["ops"],
        agentid_owner="u@x.com",
        agentid_registry_path=str(tmp_path),
        llm_config=False,
        human_input_mode="NEVER",
    )

    signed_content = agent._sign_content("Hello world")
    assert _SEPARATOR in signed_content
    content, envelope = extract_signed_payload(signed_content)
    assert content == "Hello world"
    assert envelope["did"] == agent.agentid_did


def test_agentid_mixin_verify_message(tmp_path):
    from autogen import ConversableAgent
    from autogen_agentid.agent import AgentIDMixin

    class TestAgent(AgentIDMixin, ConversableAgent):
        pass

    sender = TestAgent(
        "msg-sender",
        agentid_capabilities=["ops"],
        agentid_owner="u@x.com",
        agentid_registry_path=str(tmp_path),
        llm_config=False,
        human_input_mode="NEVER",
    )
    receiver = TestAgent(
        "msg-receiver",
        agentid_capabilities=["ops"],
        agentid_owner="u@x.com",
        agentid_registry_path=str(tmp_path),
        llm_config=False,
        human_input_mode="NEVER",
    )

    signed_content = sender._sign_content("Task complete.")
    assert receiver.verify_message(signed_content)
    assert receiver.verify_message({"content": signed_content})


def test_verify_message_fails_unsigned(tmp_path):
    from autogen import ConversableAgent
    from autogen_agentid.agent import AgentIDMixin

    class TestAgent(AgentIDMixin, ConversableAgent):
        pass

    agent = TestAgent(
        "unsigned-receiver",
        agentid_capabilities=["ops"],
        agentid_owner="u@x.com",
        agentid_registry_path=str(tmp_path),
        llm_config=False,
        human_input_mode="NEVER",
    )

    assert not agent.verify_message("plain unsigned message")


# ── create_agentid_agent ──────────────────────────────────────────────────────

def test_create_agentid_agent_factory(tmp_path):
    from autogen_agentid import create_agentid_agent

    agent = create_agentid_agent(
        name="factory-agent",
        capabilities=["translation"],
        owner="u@x.com",
        registry_path=str(tmp_path),
        llm_config=False,
        human_input_mode="NEVER",
    )

    assert agent.agentid_did.startswith("did:agentid:")
    signed = agent._sign_content("Result: done.")
    assert verify_autogen_message(signed, registry_path=str(tmp_path))
