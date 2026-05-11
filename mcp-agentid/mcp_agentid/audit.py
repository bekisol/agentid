"""
Append-only audit log for MCP tool calls.

Each call decorated with @secure generates an audit entry with:
- caller DID (or "anonymous")
- tool name
- trust score at call time
- success/failure outcome
- ISO timestamp

The log is append-only by design — entries are never modified or deleted.

Usage::

    from mcp_agentid.audit import AuditLog

    log = AuditLog("/var/log/mcp-agentid/audit.jsonl")
    log.record(
        tool="read_file",
        caller_did="did:agentid:...",
        trust_score=72.4,
        outcome="success",
        metadata={"path": "/etc/hosts"},
    )

Environment variables
---------------------
AGENTID_AUDIT_LOG  — path to the audit log file (default: ~/.agentid/audit.jsonl)
"""

from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


_DEFAULT_LOG_PATH = Path.home() / ".agentid" / "audit.jsonl"


class AuditLog:
    """
    Thread-safe append-only JSONL audit log.

    Each line is a JSON object with at minimum::

        {
            "ts":          "2026-05-09T12:34:56Z",   # ISO 8601 UTC
            "tool":        "read_file",
            "caller_did":  "did:agentid:..." | "anonymous",
            "trust_score": 72.4 | null,
            "outcome":     "success" | "permission_denied" | "error",
            "latency_ms":  42
        }
    """

    def __init__(self, path: str = None):
        p = path or os.environ.get("AGENTID_AUDIT_LOG", str(_DEFAULT_LOG_PATH))
        self.path = Path(p)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def record(
        self,
        *,
        tool: str,
        caller_did: Optional[str],
        trust_score: Optional[float] = None,
        outcome: str,
        latency_ms: Optional[float] = None,
        metadata: dict[str, Any] = None,
        error: Optional[str] = None,
    ) -> None:
        """
        Append one audit entry.

        Parameters
        ----------
        tool:        Name of the MCP tool that was called.
        caller_did:  DID of the calling agent, or None for anonymous callers.
        trust_score: Trust score at call time (0-100), or None if not checked.
        outcome:     "success" | "permission_denied" | "error"
        latency_ms:  Wall-clock latency of the tool call in milliseconds.
        metadata:    Extra key/value data to include (e.g. sanitised args).
        error:       Error message if outcome != "success".
        """
        entry: dict[str, Any] = {
            "ts":          datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "tool":        tool,
            "caller_did":  caller_did or "anonymous",
            "trust_score": trust_score,
            "outcome":     outcome,
        }
        if latency_ms is not None:
            entry["latency_ms"] = round(latency_ms, 1)
        if metadata:
            entry["metadata"] = metadata
        if error:
            entry["error"] = error

        line = json.dumps(entry, separators=(",", ":")) + "\n"
        with self._lock:
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(line)

    def tail(self, n: int = 100) -> list[dict]:
        """Return the last *n* audit entries as parsed dicts."""
        if not self.path.exists():
            return []
        lines = self.path.read_text(encoding="utf-8").strip().splitlines()
        return [json.loads(line) for line in lines[-n:] if line]


# Module-level default log (uses AGENTID_AUDIT_LOG or ~/.agentid/audit.jsonl)
_default_log: Optional[AuditLog] = None


def _get_default_log() -> AuditLog:
    global _default_log
    if _default_log is None:
        _default_log = AuditLog()
    return _default_log


def record(
    *,
    tool: str,
    caller_did: Optional[str],
    trust_score: Optional[float] = None,
    outcome: str,
    latency_ms: Optional[float] = None,
    metadata: dict = None,
    error: Optional[str] = None,
) -> None:
    """Convenience wrapper — writes to the default audit log."""
    _get_default_log().record(
        tool=tool,
        caller_did=caller_did,
        trust_score=trust_score,
        outcome=outcome,
        latency_ms=latency_ms,
        metadata=metadata,
        error=error,
    )
