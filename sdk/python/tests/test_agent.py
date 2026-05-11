import pytest
import tempfile
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from agentid import Agent
from agentid.agent import AgentDocument
from agentid.identity import generate_keypair, public_key_to_did, did_to_public_key_bytes
from agentid.crypto import sign, verify


@pytest.fixture
def tmp_registry(tmp_path):
    return str(tmp_path / "registry")


# ── identity ──────────────────────────────────────────────────────────────────

def test_generate_keypair():
    priv, pub = generate_keypair()
    assert len(priv) == 32
    assert len(pub) == 32


def test_did_roundtrip():
    _, pub = generate_keypair()
    did = public_key_to_did(pub)
    assert did.startswith("did:agentid:")
    recovered = did_to_public_key_bytes(did)
    assert recovered == pub


def test_invalid_did():
    with pytest.raises(ValueError):
        did_to_public_key_bytes("not:a:valid:did")


# ── crypto ────────────────────────────────────────────────────────────────────

def test_sign_verify():
    priv, pub = generate_keypair()
    payload = {"task": "search the web", "priority": 1}
    sig = sign(priv, payload)
    assert verify(pub, payload, sig)


def test_tampered_payload_fails():
    priv, pub = generate_keypair()
    payload = {"task": "book flight"}
    sig = sign(priv, payload)
    tampered = {"task": "book first class"}
    assert not verify(pub, tampered, sig)


def test_wrong_key_fails():
    priv1, _ = generate_keypair()
    _, pub2 = generate_keypair()
    payload = {"msg": "hello"}
    sig = sign(priv1, payload)
    assert not verify(pub2, payload, sig)


# ── agent ─────────────────────────────────────────────────────────────────────

def test_create_agent(tmp_registry):
    agent = Agent.create(
        name="test-agent",
        capabilities=["search", "summarize"],
        owner="test@example.com",
        registry_path=tmp_registry,
    )
    assert agent.name == "test-agent"
    assert "search" in agent.capabilities
    assert agent.did.startswith("did:agentid:")


def test_load_agent(tmp_registry):
    agent = Agent.create(
        name="loadable",
        capabilities=["code-review"],
        owner="dev@example.com",
        registry_path=tmp_registry,
    )
    loaded = Agent.load(agent.did, registry_path=tmp_registry)
    assert loaded.did == agent.did
    assert loaded.name == agent.name


def test_resolve_agent(tmp_registry):
    agent = Agent.create(
        name="resolver-test",
        capabilities=["translate"],
        owner="user@example.com",
        registry_path=tmp_registry,
    )
    doc = Agent.resolve(agent.did, registry_path=tmp_registry)
    assert isinstance(doc, AgentDocument)
    assert doc.did == agent.did


def test_resolve_unknown_returns_none(tmp_registry):
    result = Agent.resolve("did:agentid:doesnotexist", registry_path=tmp_registry)
    assert result is None


def test_find_by_capability(tmp_registry):
    Agent.create("a1", ["flight-search", "hotels"], "u@x.com", registry_path=tmp_registry)
    Agent.create("a2", ["code-review"], "u@x.com", registry_path=tmp_registry)
    Agent.create("a3", ["flight-search"], "u@x.com", registry_path=tmp_registry)

    results = Agent.find(capability="flight-search", registry_path=tmp_registry)
    names = [a.name for a in results]
    assert "a1" in names
    assert "a3" in names
    assert "a2" not in names


# ── signing ───────────────────────────────────────────────────────────────────

def test_agent_sign_and_verify(tmp_registry):
    agent = Agent.create("signer", ["task-runner"], "u@x.com", registry_path=tmp_registry)
    signed = agent.sign({"task": "run pipeline"})

    assert "payload" in signed
    assert "signature" in signed
    assert signed["payload"]["signer"] == agent.did

    assert agent.verify_message(signed)


def test_verify_from_did(tmp_registry):
    agent = Agent.create("did-verifier", ["ops"], "u@x.com", registry_path=tmp_registry)
    signed = agent.sign({"action": "deploy"})
    assert Agent.verify_from_did(signed, registry_path=tmp_registry)


def test_tampered_message_fails(tmp_registry):
    agent = Agent.create("tamper-test", ["ops"], "u@x.com", registry_path=tmp_registry)
    signed = agent.sign({"action": "deploy"})

    tampered = {
        "payload": {**signed["payload"], "action": "destroy"},
        "signature": signed["signature"],
    }
    assert not Agent.verify_from_did(tampered, registry_path=tmp_registry)


def test_sign_requires_private_key(tmp_registry):
    agent = Agent.create("no-key", ["ops"], "u@x.com", registry_path=tmp_registry)
    read_only = Agent(agent.document, private_key_bytes=None)
    with pytest.raises(RuntimeError):
        read_only.sign({"task": "anything"})
