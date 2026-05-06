"""
BrainMemory — persistent state store for AgentBrain.

Stores per-agent memory at ~/.agentid/brain/{did}/memory.json:
  - perception state (last seen hashes/values per source)
  - action history (what the agent did and when)
  - notes (arbitrary key-value for the LLM to accumulate context)

All reads/writes are synchronous (brain runs in a thread-safe context).
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


BRAIN_DIR = Path.home() / ".agentid" / "brain"


class BrainMemory:
    """
    Lightweight JSON-backed memory for one agent brain.

    Parameters
    ----------
    did : str
        Agent DID. Used to namespace the storage directory.
    """

    def __init__(self, did: str) -> None:
        safe = did.replace(":", "_").replace("/", "_")
        self._dir = BRAIN_DIR / safe
        self._dir.mkdir(parents=True, exist_ok=True)
        self._path = self._dir / "memory.json"
        self._data = self._load()

    # ── persistence ───────────────────────────────────────────────────────────

    def _load(self) -> dict:
        if self._path.exists():
            try:
                return json.loads(self._path.read_text())
            except (json.JSONDecodeError, OSError):
                pass
        return {"perception": {}, "history": [], "notes": {}}

    def _save(self) -> None:
        try:
            self._path.write_text(json.dumps(self._data, indent=2, default=str))
        except OSError:
            pass

    # ── perception state ──────────────────────────────────────────────────────

    def get_perception_state(self, source: str) -> Optional[str]:
        """Return the last-seen state token for *source*, or None."""
        return self._data["perception"].get(source)

    def set_perception_state(self, source: str, state: str) -> None:
        """Update the last-seen state token for *source* and persist."""
        self._data["perception"][source] = state
        self._save()

    # ── action history ────────────────────────────────────────────────────────

    def record_action(self, action_type: str, detail: str) -> None:
        """Append an action to the history log (capped at 200 entries)."""
        self._data["history"].append({
            "ts":     datetime.now(timezone.utc).isoformat(),
            "type":   action_type,
            "detail": detail[:500],
        })
        self._data["history"] = self._data["history"][-200:]
        self._save()

    def recent_history(self, n: int = 10) -> list[dict]:
        """Return the *n* most recent history entries."""
        return self._data["history"][-n:]

    # ── notes (LLM-accumulated context) ──────────────────────────────────────

    def get_note(self, key: str) -> Any:
        return self._data["notes"].get(key)

    def set_note(self, key: str, value: Any) -> None:
        self._data["notes"][key] = value
        self._save()

    # ── context summary for LLM ───────────────────────────────────────────────

    def get_context(self) -> str:
        """
        Return a compact text summary of memory for inclusion in LLM prompts.
        """
        lines = []
        history = self.recent_history(5)
        if history:
            lines.append("Recent actions:")
            for h in history:
                lines.append(f"  [{h['ts'][:16]}] {h['type']}: {h['detail'][:120]}")
        notes = self._data.get("notes", {})
        if notes:
            lines.append("Accumulated notes:")
            for k, v in list(notes.items())[:5]:
                lines.append(f"  {k}: {str(v)[:120]}")
        return "\n".join(lines) if lines else "No prior history."
