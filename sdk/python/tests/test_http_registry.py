"""
Tests for the HTTP registry client.

Uses FastAPI's TestClient to spin up the server in-process —
no separate server process needed.
"""

import json
import sys
from dataclasses import asdict
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / "registry"))

from fastapi.testclient import TestClient

# Patch the registry path before importing server so it uses a temp dir
import tempfile, os
_tmp = tempfile.mkdtemp()

import agentid.registry as _reg_mod
_orig_default = _reg_mod.DEFAULT_DIR
_reg_mod.DEFAULT_DIR = Path(_tmp)

import server as registry_server
registry_server.REGISTRY = _reg_mod.Registry(path=Path(_tmp))

client = TestClient(registry_server.app)

from agentid import Agent
from agentid.http_registry import HTTPRegistry


# ── helpers ───────────────────────────────────────────────────────────────────

def make_agent(name="test-agent", capabilities=None, owner="u@x.com"):
    from agentid.identity import generate_keypair, public_key_to_did, public_key_to_b64
    import time
    from agentid.agent import AgentDocument

    priv, pub = generate_keypair()
    did = public_key_to_did(pub)
    doc = AgentDocument(
        did=did,
        name=name,
        capabilities=capabilities or ["search"],
        owner=owner,
        public_key=public_key_to_b64(pub),
        created_at=time.time(),
    )
    return doc, priv


# ── health ────────────────────────────────────────────────────────────────────

def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


# ── register ──────────────────────────────────────────────────────────────────

def test_register_agent():
    doc, _ = make_agent("register-test")
    r = client.post("/agents", json=asdict(doc))
    assert r.status_code == 201
    body = r.json()
    assert body["did"] == doc.did
    assert body["name"] == "register-test"


def test_register_duplicate_fails():
    doc, _ = make_agent("dup-test")
    client.post("/agents", json=asdict(doc))
    r = client.post("/agents", json=asdict(doc))
    assert r.status_code == 409


# ── resolve ───────────────────────────────────────────────────────────────────

def test_resolve_agent():
    doc, _ = make_agent("resolve-test")
    client.post("/agents", json=asdict(doc))

    r = client.get(f"/agents/{doc.did}")
    assert r.status_code == 200
    assert r.json()["did"] == doc.did


def test_resolve_unknown_returns_404():
    r = client.get("/agents/did:agentid:doesnotexist")
    assert r.status_code == 404


# ── discover ──────────────────────────────────────────────────────────────────

def test_discover_by_capability():
    doc1, _ = make_agent("flight-agent", ["flight-search", "hotels"])
    doc2, _ = make_agent("code-agent", ["code-review"])
    client.post("/agents", json=asdict(doc1))
    client.post("/agents", json=asdict(doc2))

    r = client.get("/agents", params={"capability": "flight-search"})
    assert r.status_code == 200
    names = [a["name"] for a in r.json()]
    assert "flight-agent" in names
    assert "code-agent" not in names


def test_discover_all():
    r = client.get("/agents")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


# ── verify signature ──────────────────────────────────────────────────────────

def test_verify_valid_signature():
    from agentid.crypto import sign
    from agentid.identity import b64_to_public_key_bytes
    import time, uuid

    doc, priv = make_agent("sig-test")
    client.post("/agents", json=asdict(doc))

    payload = {"task": "run pipeline", "signer": doc.did, "timestamp": time.time(), "nonce": str(uuid.uuid4())}
    signature = sign(priv, payload)

    r = client.post(f"/agents/{doc.did}/verify", json={"payload": payload, "signature": signature})
    assert r.status_code == 200
    assert r.json()["valid"] is True


def test_verify_tampered_signature():
    from agentid.crypto import sign
    import time, uuid

    doc, priv = make_agent("tamper-sig-test")
    client.post("/agents", json=asdict(doc))

    payload = {"task": "deploy", "signer": doc.did, "timestamp": time.time(), "nonce": str(uuid.uuid4())}
    signature = sign(priv, payload)

    tampered = {**payload, "task": "destroy"}
    r = client.post(f"/agents/{doc.did}/verify", json={"payload": tampered, "signature": signature})
    assert r.status_code == 200
    assert r.json()["valid"] is False


# ── deregister ────────────────────────────────────────────────────────────────

def test_deregister_agent():
    doc, _ = make_agent("delete-me", owner="owner@x.com")
    client.post("/agents", json=asdict(doc))

    r = client.delete(f"/agents/{doc.did}", params={"owner": "owner@x.com"})
    assert r.status_code == 204

    r = client.get(f"/agents/{doc.did}")
    assert r.status_code == 404


def test_deregister_wrong_owner_fails():
    doc, _ = make_agent("keep-me", owner="real@x.com")
    client.post("/agents", json=asdict(doc))

    r = client.delete(f"/agents/{doc.did}", params={"owner": "hacker@x.com"})
    assert r.status_code == 403


# ── Agent class with registry_url ─────────────────────────────────────────────

def test_agent_create_with_http_registry(tmp_path, monkeypatch):
    """Agent.create() registers to the server when registry_url is provided."""

    # Patch HTTPRegistry to use the TestClient instead of real httpx
    import agentid.http_registry as hr

    class PatchedHTTPRegistry(hr.HTTPRegistry):
        def __init__(self, url, keys_dir=None):
            super().__init__(url, keys_dir=str(tmp_path / "keys"))

        def _post(self, path, **kwargs):
            return client.post(path, **kwargs)

        def _get(self, path, **kwargs):
            return client.get(path, **kwargs)

        def register(self, document, private_key_bytes):
            from dataclasses import asdict
            r = client.post("/agents", json=asdict(document))
            if r.status_code == 409:
                raise ValueError(f"Already registered: {document.did}")
            r.raise_for_status()
            self._save_private_key(document.did, private_key_bytes)

        def get(self, did):
            r = client.get(f"/agents/{did}")
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r.json()

        def search(self, capability=None, owner=None):
            params = {}
            if capability:
                params["capability"] = capability
            if owner:
                params["owner"] = owner
            r = client.get("/agents", params=params)
            r.raise_for_status()
            return r.json()

    monkeypatch.setattr("agentid.agent.HTTPRegistry", PatchedHTTPRegistry)

    agent = Agent.create(
        name="http-agent",
        capabilities=["translate"],
        owner="test@x.com",
        registry_url="http://testserver",
    )
    assert agent.did.startswith("did:agentid:")
    assert agent.name == "http-agent"

    # Resolve it back from the server
    doc = Agent.resolve(agent.did, registry_url="http://testserver")
    assert doc is not None
    assert doc.name == "http-agent"
