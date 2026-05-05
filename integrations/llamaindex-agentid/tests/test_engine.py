"""Basic tests for AgentIDQueryEngine (no LlamaIndex required — uses mocks)."""

import json
import types
import unittest
from unittest.mock import MagicMock, patch


class FakeResponse:
    """Minimal stand-in for llama_index.core.response.schema.Response."""
    def __init__(self, text: str):
        self.response = text
        self.metadata = {}

    def __str__(self):
        return self.response


class FakeAgent:
    def __init__(self):
        self.did = "did:agentid:testkey123"
        self.name = "test-agent"

    def sign(self, payload):
        return {
            "payload": payload,
            "signature": "fakesig",
            "signer_did": self.did,
        }

    @staticmethod
    def create(**kwargs):
        return FakeAgent()

    @staticmethod
    def load(did, **kwargs):
        return FakeAgent()

    @staticmethod
    def verify_from_did(msg, **kwargs):
        return msg.get("signature") == "fakesig"


class TestAgentIDQueryEngine(unittest.TestCase):
    def _make_engine(self):
        fake_qe = MagicMock()
        fake_qe.query.return_value = FakeResponse("AI safety is important.")

        agentid_mod = types.ModuleType("agentid")
        agentid_mod.Agent = FakeAgent

        import sys
        sys.modules.setdefault("agentid", agentid_mod)

        from llamaindex_agentid.engine import AgentIDQueryEngine

        engine = AgentIDQueryEngine(
            query_engine=fake_qe,
            name="test-agent",
            capabilities=["research"],
            owner="test@example.com",
        )
        return engine, fake_qe

    def test_did_is_set(self):
        engine, _ = self._make_engine()
        self.assertTrue(engine.did.startswith("did:agentid:"))

    def test_query_signs_response(self):
        engine, _ = self._make_engine()
        response = engine.query("What is AI safety?")
        self.assertIn("_agentid_did", response.metadata)
        self.assertIn("_agentid_signature", response.metadata)
        self.assertIn("_agentid_payload", response.metadata)
        self.assertEqual(response.metadata["_agentid_did"], "did:agentid:testkey123")

    def test_verify_response(self):
        engine, _ = self._make_engine()
        response = engine.query("What is AI safety?")
        self.assertTrue(engine.verify_response(response))

    def test_verify_fails_without_metadata(self):
        engine, _ = self._make_engine()
        bad_response = FakeResponse("tampered")
        self.assertFalse(engine.verify_response(bad_response))


if __name__ == "__main__":
    unittest.main()
