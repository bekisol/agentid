"""
Trust score helpers for mcp-agentid.

Fetches trust scores from the AgentID registry.  Results are cached
per-DID for 5 minutes to avoid hammering the registry on every call.
"""

from __future__ import annotations

import os
import time
import urllib.request
import json
from typing import Optional


_CACHE: dict[str, tuple[float, dict]] = {}  # did → (expires_ts, data)
_CACHE_TTL = 300  # 5 minutes


def _registry_url() -> str:
    url = os.environ.get("AGENTID_REGISTRY_URL", "https://api.agentid-protocol.com")
    return url.rstrip("/")


def get_trust_score(did: str, *, registry_url: str = None, detailed: bool = False) -> dict:
    """
    Fetch the trust score for *did* from the AgentID registry.

    Returns a dict with at least::

        {
            "did":          "did:agentid:...",
            "name":         "my-agent",
            "score":        72.4,          # 0-100
            "level":        "trusted",
            "top_3_issues": [...],
            "trust_brief":  "..."
        }

    Results are cached for 5 minutes per DID.

    Parameters
    ----------
    did:          DID to look up.
    registry_url: Override the registry URL (default: AGENTID_REGISTRY_URL env).
    detailed:     If True, also fetch ``dimensions`` and ``breakdown`` fields.

    Raises
    ------
    LookupError: DID not found or registry unreachable.
    """
    now = time.time()
    cache_key = f"{did}:{'detailed' if detailed else 'default'}"
    cached = _CACHE.get(cache_key)
    if cached and cached[0] > now:
        return cached[1]

    url = (registry_url or _registry_url()) + f"/agents/{did}/trust-score"
    if detailed:
        url += "?detailed=true"

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "mcp-agentid/0.1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise LookupError(
                f"Agent {did!r} not found in registry at {registry_url or _registry_url()}. "
                "Check the DID is registered and not private."
            ) from exc
        raise LookupError(
            f"Registry returned HTTP {exc.code} for {did!r}: {exc.reason}"
        ) from exc
    except Exception as exc:
        raise LookupError(
            f"Could not fetch trust score for {did!r}: {exc}. "
            "Check AGENTID_REGISTRY_URL is set correctly."
        ) from exc

    _CACHE[cache_key] = (now + _CACHE_TTL, data)
    return data


def check_trust(
    caller_did: str,
    *,
    trust_min: float = 0.0,
    capabilities: list[str] = None,
    registry_url: str = None,
) -> None:
    """
    Verify that *caller_did* meets the required trust threshold and has the
    declared capabilities.

    Parameters
    ----------
    caller_did:   DID of the calling agent.
    trust_min:    Minimum trust score (0.0–1.0).  0.0 disables the check.
    capabilities: Required capability strings.  If any are missing, raises
                  ``PermissionError``.
    registry_url: Override registry URL.

    Raises
    ------
    PermissionError: Trust score below threshold or missing capabilities.
    LookupError:     DID not found.
    """
    if not caller_did:
        return  # anonymous callers — allow (caller_did is optional)

    if trust_min <= 0.0 and not capabilities:
        return  # nothing to check

    data = get_trust_score(caller_did, registry_url=registry_url)
    score_100 = float(data.get("score", 0))
    score_01  = score_100 / 100.0

    if trust_min > 0.0 and score_01 < trust_min:
        top_issues = data.get("top_3_issues", [])
        raise PermissionError(
            f"Agent {caller_did!r} trust score {score_100:.1f}/100 ({score_01:.2f}) "
            f"is below required {trust_min:.2f} ({trust_min * 100:.1f}/100). "
            + (f"Top issues: {'; '.join(top_issues)}" if top_issues else "")
        )

    if capabilities:
        agent_caps: list[str] = data.get("capabilities", [])
        missing = [c for c in capabilities if c not in agent_caps]
        if missing:
            raise PermissionError(
                f"Agent {caller_did!r} is missing required capabilities: {missing}. "
                f"Agent has: {agent_caps}"
            )
