"""
Tests for the @secure decorator and mcp-agentid package.

These tests run without a live AgentID registry by mocking the trust
score fetching.  Integration tests (requiring a real registry) are
tagged with pytest.mark.integration and skipped in CI unless
AGENTID_REGISTRY_URL is set.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

# Add package to path for local dev
sys.path.insert(0, str(Path(__file__).parent.parent))

from mcp_agentid import secure, AuditLog, get_trust_score, check_trust
from mcp_agentid.decorator import _sign_result


# ── helpers ───────────────────────────────────────────────────────────────────

MOCK_TRUST_SCORE = {
    "did":          "did:agentid:testcaller",
    "name":         "Test Caller",
    "score":        75.0,
    "level":        "good",
    "top_3_issues": [],
    "trust_brief":  "Good standing agent.",
    "capabilities": ["web-search", "file-read"],
}

LOW_TRUST_SCORE = {
    **MOCK_TRUST_SCORE,
    "score": 20.0,
    "level": "low",
    "top_3_issues": ["No peer attestations (D3 −10)", "Key never rotated (D1 −5)"],
}


def _mock_get_trust(did: str, **kwargs) -> dict:
    if did == "did:agentid:testcaller":
        return MOCK_TRUST_SCORE
    if did == "did:agentid:lowtrust":
        return LOW_TRUST_SCORE
    raise LookupError(f"Mock: {did!r} not found")


# ── 1. Basic decorator behaviour ──────────────────────────────────────────────

def test_secure_passes_anonymous():
    """Anonymous calls (no caller_did) are allowed by default."""
    @secure()
    def greet(name: str, *, caller_did: str = None) -> str:
        return f"Hello, {name}!"

    result = greet("world")
    assert result == "Hello, world!"


def test_secure_preserves_return_value():
    """@secure must not alter the return value when no signing is requested."""
    @secure()
    def compute(x: int, *, caller_did: str = None) -> int:
        return x * 2

    assert compute(21) == 42


def test_secure_preserves_function_metadata():
    """@secure must not clobber __name__ or __doc__."""
    @secure(trust_min=0.5)
    def my_tool(*, caller_did: str = None) -> str:
        """My tool docstring."""
        return "ok"

    assert my_tool.__name__ == "my_tool"
    assert my_tool.__doc__ == "My tool docstring."


def test_secure_sets_metadata_attrs():
    """Decorated function should carry trust_min and capabilities as attributes."""
    @secure(trust_min=0.7, capabilities=["web-search"])
    def search(*, caller_did: str = None) -> list:
        return []

    assert search._mcp_secure is True
    assert search._trust_min == 0.7
    assert "web-search" in search._capabilities


# ── 2. Trust score enforcement ────────────────────────────────────────────────

def test_trust_min_passes_high_trust():
    """Caller with trust above threshold should pass."""
    with patch("mcp_agentid.decorator.get_trust_score", side_effect=_mock_get_trust), \
         patch("mcp_agentid.decorator.check_trust") as mock_check:
        mock_check.return_value = None  # no exception = pass

        @secure(trust_min=0.6)
        def tool(*, caller_did: str = None) -> str:
            return "ok"

        result = tool(caller_did="did:agentid:testcaller")
        assert result == "ok"
        mock_check.assert_called_once_with(
            "did:agentid:testcaller",
            trust_min=0.6,
            capabilities=None,
            registry_url=None,
        )


def test_trust_min_blocks_low_trust():
    """Caller with trust below threshold must raise PermissionError."""
    with patch("mcp_agentid.decorator.check_trust") as mock_check:
        mock_check.side_effect = PermissionError("Trust score 20.0/100 below required 60.0/100")

        @secure(trust_min=0.6)
        def tool(*, caller_did: str = None) -> str:
            return "ok"

        with pytest.raises(PermissionError, match="Trust score"):
            tool(caller_did="did:agentid:lowtrust")


def test_anonymous_blocked_when_not_allowed():
    """When allow_anonymous=False, calls without caller_did must raise ValueError."""
    @secure(allow_anonymous=False)
    def restricted(*, caller_did: str = None) -> str:
        return "ok"

    with pytest.raises(ValueError, match="requires a verified caller DID"):
        restricted()  # no caller_did


# ── 3. Audit log ──────────────────────────────────────────────────────────────

def test_audit_log_writes_entry(tmp_path):
    """AuditLog.record() must append a valid JSONL entry."""
    log = AuditLog(str(tmp_path / "audit.jsonl"))
    log.record(
        tool="test_tool",
        caller_did="did:agentid:abc",
        trust_score=72.4,
        outcome="success",
        latency_ms=12.3,
    )

    lines = (tmp_path / "audit.jsonl").read_text().strip().splitlines()
    assert len(lines) == 1
    entry = json.loads(lines[0])
    assert entry["tool"] == "test_tool"
    assert entry["caller_did"] == "did:agentid:abc"
    assert entry["trust_score"] == 72.4
    assert entry["outcome"] == "success"
    assert entry["latency_ms"] == 12.3
    assert "ts" in entry


def test_audit_log_multiple_entries(tmp_path):
    """Multiple records should append correctly (JSONL — one JSON object per line)."""
    log = AuditLog(str(tmp_path / "audit.jsonl"))
    for i in range(5):
        log.record(tool=f"tool_{i}", caller_did=None, outcome="success")

    entries = log.tail(10)
    assert len(entries) == 5
    assert [e["tool"] for e in entries] == [f"tool_{i}" for i in range(5)]


def test_audit_log_anonymous_caller(tmp_path):
    """Calls with caller_did=None should log as 'anonymous'."""
    log = AuditLog(str(tmp_path / "audit.jsonl"))
    log.record(tool="anon_tool", caller_did=None, outcome="success")
    entry = log.tail(1)[0]
    assert entry["caller_did"] == "anonymous"


def test_secure_writes_audit_on_success(tmp_path):
    """@secure must write an audit entry even on successful calls."""
    log_path = str(tmp_path / "audit.jsonl")
    with patch.dict(os.environ, {"AGENTID_AUDIT_LOG": log_path}), \
         patch("mcp_agentid.audit._default_log", None):

        @secure(audit=True)
        def my_tool(*, caller_did: str = None) -> str:
            return "done"

        my_tool(caller_did="did:agentid:someone")

    entries = AuditLog(log_path).tail(1)
    assert len(entries) == 1
    assert entries[0]["tool"] == "my_tool"
    assert entries[0]["outcome"] == "success"


def test_secure_writes_audit_on_permission_error(tmp_path):
    """@secure must write a 'permission_denied' audit entry when trust check fails."""
    log_path = str(tmp_path / "audit.jsonl")
    with patch.dict(os.environ, {"AGENTID_AUDIT_LOG": log_path}), \
         patch("mcp_agentid.audit._default_log", None), \
         patch("mcp_agentid.decorator.check_trust") as mock_check:
        mock_check.side_effect = PermissionError("Low trust")

        @secure(trust_min=0.8, audit=True)
        def restricted(*, caller_did: str = None) -> str:
            return "ok"

        with pytest.raises(PermissionError):
            restricted(caller_did="did:agentid:lowtrust")

    entries = AuditLog(log_path).tail(1)
    assert entries[0]["outcome"] == "permission_denied"
    assert "Low trust" in entries[0].get("error", "")


# ── 4. Audit disabled ─────────────────────────────────────────────────────────

def test_secure_no_audit(tmp_path):
    """@secure with audit=False must not write any log entries."""
    log_path = str(tmp_path / "audit.jsonl")
    with patch.dict(os.environ, {"AGENTID_AUDIT_LOG": log_path}), \
         patch("mcp_agentid.audit._default_log", None):

        @secure(audit=False)
        def silent_tool(*, caller_did: str = None) -> str:
            return "quiet"

        silent_tool()

    assert not Path(log_path).exists()


# ── 5. Capability check (via check_trust mock) ────────────────────────────────

def test_capability_check_passes():
    """check_trust() should not raise when capabilities are met."""
    with patch("mcp_agentid.trust.get_trust_score", side_effect=_mock_get_trust):
        # Should not raise
        check_trust(
            "did:agentid:testcaller",
            trust_min=0.5,
            capabilities=["web-search"],
        )


def test_capability_check_missing():
    """check_trust() should raise PermissionError when capabilities are missing."""
    with patch("mcp_agentid.trust.get_trust_score", side_effect=_mock_get_trust):
        with pytest.raises(PermissionError, match="missing required capabilities"):
            check_trust(
                "did:agentid:testcaller",
                trust_min=0.0,
                capabilities=["database-write"],   # not in MOCK_TRUST_SCORE
            )


# ── 6. sign_response (without real keys) ──────────────────────────────────────

def test_sign_result_no_env_vars():
    """_sign_result without env vars must return result with signed=False warning."""
    result = _sign_result({"data": 42}, caller_did="did:agentid:x")
    assert result["result"] == {"data": 42}
    assert result["signed"] is False
    assert "warning" in result


def test_secure_sign_response_no_keys():
    """@secure(sign_response=True) without env vars returns result with warning."""
    @secure(sign_response=True)
    def tool(*, caller_did: str = None) -> dict:
        return {"status": "ok"}

    result = tool()
    assert result["result"] == {"status": "ok"}
    assert result["signed"] is False
