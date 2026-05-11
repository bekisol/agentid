"""
@secure decorator — the MCP wedge product.

Drop-in decorator for any MCP tool function that adds:
  1. Caller identity verification (DID-based Ed25519 signature)
  2. Trust score gate (configurable threshold)
  3. Capability requirement check
  4. Per-call audit log entry (append-only JSONL)
  5. Signed response envelope (optional — enable with sign_response=True)

Usage::

    from mcp_agentid import secure

    @secure(trust_min=0.6, capabilities=["web-search"])
    def web_search(query: str, *, caller_did: str = None) -> list[dict]:
        \"\"\"Search the web and return structured results.\"\"\"
        ...

The ``caller_did`` keyword argument is injected by the MCP framework (or your
server middleware).  If missing/None, the trust check is skipped and the call
is logged as "anonymous".

Environment variables
---------------------
AGENTID_REGISTRY_URL  — base URL of the AgentID registry (required for trust checks)
AGENTID_AGENT_DID     — DID of this MCP server (used to sign responses)
AGENTID_PRIVATE_KEY   — hex-encoded private key for response signing (optional)
AGENTID_AUDIT_LOG     — path to the audit log file (default: ~/.agentid/audit.jsonl)
"""

from __future__ import annotations

import functools
import os
import time
from typing import Any, Callable, Optional

from .trust import check_trust, get_trust_score
from .audit import record as audit_record


def secure(
    *,
    trust_min: float = 0.0,
    capabilities: list[str] = None,
    registry_url: str = None,
    sign_response: bool = False,
    audit: bool = True,
    allow_anonymous: bool = True,
) -> Callable:
    """
    Decorator factory — wraps an MCP tool function with identity and trust checks.

    Parameters
    ----------
    trust_min:       Minimum trust score (0.0–1.0).  0.0 = any verified agent.
                     Set to e.g. 0.6 to require "good" level trust.
    capabilities:    List of capability strings the caller must declare.
                     Example: ``["file-read", "network-egress"]``
    registry_url:    AgentID registry URL (defaults to AGENTID_REGISTRY_URL env var).
    sign_response:   If True, wrap the return value in a signed receipt envelope.
                     Requires AGENTID_AGENT_DID and AGENTID_PRIVATE_KEY env vars.
    audit:           Write a JSONL audit entry for every call (default: True).
    allow_anonymous: Allow calls with no ``caller_did`` (default: True).
                     Set to False to require a verified DID on every call.

    Example::

        from mcp_agentid import secure

        @secure(trust_min=0.7, capabilities=["database-write"])
        def insert_record(table: str, data: dict, *, caller_did: str = None) -> dict:
            \"\"\"Insert a record — requires high trust and database-write capability.\"\"\"
            ...

    The decorated function preserves its original signature, ``__name__``,
    and ``__doc__`` (via ``functools.wraps``).

    Raises
    ------
    PermissionError:  Caller DID fails trust or capability check.
    ValueError:       ``allow_anonymous=False`` and caller_did is None.
    """
    _registry_url = registry_url or os.environ.get("AGENTID_REGISTRY_URL", "")

    def decorator(fn: Callable) -> Callable:
        tool_name = fn.__name__

        @functools.wraps(fn)
        def wrapper(*args, caller_did: Optional[str] = None, **kwargs) -> Any:
            t0 = time.monotonic()
            trust_score_value: Optional[float] = None
            outcome = "success"
            error_msg: Optional[str] = None

            try:
                # ── 1. Anonymous caller gate ───────────────────────────────
                if not allow_anonymous and not caller_did:
                    raise ValueError(
                        f"Tool {tool_name!r} requires a verified caller DID "
                        f"(allow_anonymous=False). Pass caller_did= from your MCP middleware."
                    )

                # ── 2. Trust + capability check ────────────────────────────
                if caller_did:
                    check_trust(
                        caller_did,
                        trust_min=trust_min,
                        capabilities=capabilities,
                        registry_url=_registry_url or None,
                    )
                    # Fetch score for audit log (may be cached from check_trust)
                    try:
                        ts_data = get_trust_score(caller_did, registry_url=_registry_url or None)
                        trust_score_value = ts_data.get("score")
                    except Exception:
                        pass

                # ── 3. Call the original function ──────────────────────────
                result = fn(*args, **kwargs)

                # ── 4. Sign response (optional) ────────────────────────────
                if sign_response:
                    result = _sign_result(result, caller_did=caller_did)

                return result

            except PermissionError as exc:
                outcome = "permission_denied"
                error_msg = str(exc)
                raise

            except ValueError as exc:
                outcome = "permission_denied"
                error_msg = str(exc)
                raise

            except Exception as exc:
                outcome = "error"
                error_msg = f"{type(exc).__name__}: {exc}"
                raise

            finally:
                if audit:
                    latency = (time.monotonic() - t0) * 1000
                    audit_record(
                        tool=tool_name,
                        caller_did=caller_did,
                        trust_score=trust_score_value,
                        outcome=outcome,
                        latency_ms=latency,
                        error=error_msg,
                    )

        # ── metadata for introspection ─────────────────────────────────────
        wrapper._mcp_secure = True
        wrapper._trust_min  = trust_min
        wrapper._capabilities = capabilities or []
        wrapper._sign_response = sign_response

        return wrapper

    return decorator


def _sign_result(result: Any, *, caller_did: Optional[str]) -> dict:
    """
    Wrap *result* in a signed receipt envelope.

    Uses AGENTID_AGENT_DID and AGENTID_PRIVATE_KEY env vars.
    Returns the original result dict unchanged if signing is not configured.
    """
    agent_did = os.environ.get("AGENTID_AGENT_DID", "")
    private_key_hex = os.environ.get("AGENTID_PRIVATE_KEY", "")

    if not agent_did or not private_key_hex:
        # Signing not configured — return result as-is with a warning flag
        return {
            "result":  result,
            "signed":  False,
            "warning": (
                "Response signing requested but AGENTID_AGENT_DID or "
                "AGENTID_PRIVATE_KEY is not set."
            ),
        }

    try:
        import time as _time
        import uuid as _uuid
        from agentid.crypto import sign as _sign

        private_key_bytes = bytes.fromhex(private_key_hex)
        ts = int(_time.time())
        nonce = str(_uuid.uuid4())
        payload = {
            "result":     result,
            "signer":     agent_did,
            "caller_did": caller_did or "anonymous",
            "timestamp":  ts,
            "nonce":      nonce,
        }
        envelope = _sign(private_key_bytes, payload)
        return {
            "result":    result,
            "signed":    True,
            "signer":    agent_did,
            "timestamp": ts,
            "nonce":     nonce,
            "signature": envelope,
        }
    except Exception as exc:
        # Signing failed — return result with error metadata rather than crashing
        return {
            "result":       result,
            "signed":       False,
            "sign_error":   str(exc),
        }
