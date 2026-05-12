"""
Trust-Brief MCP Middleware

Drop-in client-side shim that injects AgentID identity and trust context
into every outgoing MCP ``tools/call`` request.  Works at three levels:

1. **HTTP transport** — ``TrustBriefTransport`` wraps an HTTPX transport,
   adding ``X-AgentID-*`` headers to every request automatically.

2. **HTTPX client** — ``build_httpx_client()`` returns a pre-configured
   ``httpx.Client`` (or ``AsyncClient``) with the transport attached.

3. **Standalone header builder** — ``build_trust_headers()`` returns the
   dict of headers for any HTTP library.

The gap filled: MCP has no native agent identifier on the wire.  An MCP
server only knows the OAuth subject (a human) or nothing (stdio).  This
middleware stamps every outgoing call with:
  - ``X-AgentID-DID``          — the calling agent's DID
  - ``X-AgentID-Trust-Score``  — composite 0-100 score (cached 5 min)
  - ``X-AgentID-Trust-Level``  — "excellent" | "good" | "moderate" | "low"
  - ``X-AgentID-Trust-Brief``  — short LLM-readable narrative
  - ``X-AgentID-Risk-Band``    — "low" | "moderate" | "elevated" | "high"
  - ``X-AgentID-Registry``     — registry base URL for independent lookup

Environment variables
---------------------
AGENTID_AGENT_DID       — DID of the agent making calls (required)
AGENTID_REGISTRY_URL    — AgentID registry base URL (default: https://api.agentid-protocol.com)

Example — HTTPX client
----------------------
::

    from mcp_agentid.middleware import build_httpx_client

    client = build_httpx_client(
        agent_did="did:agentid:7mK9xR2pQnFvLsB3YhTcWjAeXdUoNgZi",
    )
    # All requests from this client carry X-AgentID-* headers automatically.
    resp = client.post("https://mcp.example.com/tools/call", json={...})

Example — raw headers
---------------------
::

    from mcp_agentid.middleware import build_trust_headers

    headers = build_trust_headers("did:agentid:...")
    requests.post(url, json=body, headers=headers)

Example — MCP SDK (Python mcp library)
---------------------------------------
::

    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client
    from mcp_agentid.middleware import TrustBriefTransport

    import httpx

    # Wrap the default HTTPX transport with the trust-brief shim
    inner   = httpx.AsyncHTTPTransport()
    wrapped = TrustBriefTransport(inner, agent_did="did:agentid:...")

    async with httpx.AsyncClient(transport=wrapped) as http:
        async with streamablehttp_client("https://mcp.example.com/mcp/sse", http_client=http) as (r, w, _):
            async with ClientSession(r, w) as session:
                await session.initialize()
                result = await session.call_tool("my_tool", {"param": "value"})
"""

from __future__ import annotations

import os
import time
from typing import Optional

from .trust import get_trust_score

__all__ = [
    "TrustBriefTransport",
    "AsyncTrustBriefTransport",
    "build_trust_headers",
    "build_httpx_client",
    "build_async_httpx_client",
]

_REGISTRY_URL = os.environ.get("AGENTID_REGISTRY_URL", "https://api.agentid-protocol.com")
_AGENT_DID    = os.environ.get("AGENTID_AGENT_DID", "")

# Header name constants — servers can use these to parse inbound calls
HEADER_DID          = "X-AgentID-DID"
HEADER_TRUST_SCORE  = "X-AgentID-Trust-Score"
HEADER_TRUST_LEVEL  = "X-AgentID-Trust-Level"
HEADER_TRUST_BRIEF  = "X-AgentID-Trust-Brief"
HEADER_RISK_BAND    = "X-AgentID-Risk-Band"
HEADER_REGISTRY     = "X-AgentID-Registry"


def _score_to_risk_band(score: float) -> str:
    if score >= 80: return "low"
    if score >= 60: return "moderate"
    if score >= 30: return "elevated"
    return "high"


def build_trust_headers(
    agent_did: str = "",
    *,
    registry_url: str = "",
    trust_score_override: Optional[dict] = None,
) -> dict[str, str]:
    """
    Build the ``X-AgentID-*`` header dict for the given agent DID.

    Parameters
    ----------
    agent_did:
        DID of the calling agent. Falls back to ``AGENTID_AGENT_DID`` env var.
    registry_url:
        AgentID registry base URL. Falls back to ``AGENTID_REGISTRY_URL``.
    trust_score_override:
        Pre-fetched trust score dict (skips the registry lookup). Useful
        when you already have the score and want to avoid a network call.

    Returns
    -------
    dict
        Headers ready to pass to any HTTP client (requests, httpx, aiohttp).
        Empty dict if no ``agent_did`` is available.
    """
    did  = agent_did or _AGENT_DID
    reg  = (registry_url or _REGISTRY_URL).rstrip("/")

    if not did:
        return {}

    headers: dict[str, str] = {
        HEADER_DID:      did,
        HEADER_REGISTRY: reg,
    }

    try:
        ts = trust_score_override or get_trust_score(did, registry_url=reg or None)
        score = float(ts.get("score", 0))
        headers[HEADER_TRUST_SCORE] = str(round(score, 1))
        headers[HEADER_TRUST_LEVEL] = ts.get("level", "")
        headers[HEADER_RISK_BAND]   = _score_to_risk_band(score)

        brief = ts.get("trust_brief") or ""
        if brief:
            # Truncate to 500 chars — HTTP headers have practical limits
            headers[HEADER_TRUST_BRIEF] = brief[:500]
    except Exception:
        # Registry unreachable — still stamp the DID, omit score headers
        pass

    return headers


# ── HTTPX transport wrappers ──────────────────────────────────────────────────

class TrustBriefTransport:
    """
    Synchronous HTTPX transport that prepends ``X-AgentID-*`` headers to
    every request before forwarding to the wrapped transport.

    Compatible with any ``httpx.BaseTransport`` implementation.
    """

    def __init__(
        self,
        wrapped,
        *,
        agent_did: str = "",
        registry_url: str = "",
        refresh_interval: int = 300,
    ):
        """
        Parameters
        ----------
        wrapped:
            Inner ``httpx.BaseTransport`` to delegate to after adding headers.
        agent_did:
            DID of the calling agent. Falls back to ``AGENTID_AGENT_DID``.
        registry_url:
            Override registry URL.
        refresh_interval:
            Seconds between trust-score cache refreshes (default 300 = 5 min).
        """
        self._inner           = wrapped
        self._agent_did       = agent_did or _AGENT_DID
        self._registry_url    = registry_url or _REGISTRY_URL
        self._refresh_interval = refresh_interval
        self._cached_headers: dict[str, str] = {}
        self._cache_expires: float = 0.0

    def _get_headers(self) -> dict[str, str]:
        now = time.monotonic()
        if now > self._cache_expires:
            self._cached_headers = build_trust_headers(
                self._agent_did,
                registry_url=self._registry_url,
            )
            self._cache_expires = now + self._refresh_interval
        return self._cached_headers

    def handle_request(self, request):
        trust_headers = self._get_headers()
        for k, v in trust_headers.items():
            request.headers[k] = v
        return self._inner.handle_request(request)

    def close(self):
        self._inner.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class AsyncTrustBriefTransport:
    """
    Async HTTPX transport that prepends ``X-AgentID-*`` headers to every
    request. Use with ``httpx.AsyncClient``.
    """

    def __init__(
        self,
        wrapped,
        *,
        agent_did: str = "",
        registry_url: str = "",
        refresh_interval: int = 300,
    ):
        self._inner            = wrapped
        self._agent_did        = agent_did or _AGENT_DID
        self._registry_url     = registry_url or _REGISTRY_URL
        self._refresh_interval = refresh_interval
        self._cached_headers: dict[str, str] = {}
        self._cache_expires: float = 0.0

    def _get_headers(self) -> dict[str, str]:
        now = time.monotonic()
        if now > self._cache_expires:
            self._cached_headers = build_trust_headers(
                self._agent_did,
                registry_url=self._registry_url,
            )
            self._cache_expires = now + self._refresh_interval
        return self._cached_headers

    async def handle_async_request(self, request):
        trust_headers = self._get_headers()
        for k, v in trust_headers.items():
            request.headers[k] = v
        return await self._inner.handle_async_request(request)

    async def aclose(self):
        await self._inner.aclose()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.aclose()


# ── Convenience factories ─────────────────────────────────────────────────────

def build_httpx_client(
    agent_did: str = "",
    *,
    registry_url: str = "",
    refresh_interval: int = 300,
    **httpx_kwargs,
):
    """
    Return a pre-configured ``httpx.Client`` that automatically injects
    ``X-AgentID-*`` headers into every request.

    Parameters
    ----------
    agent_did:
        DID of the calling agent. Falls back to ``AGENTID_AGENT_DID``.
    registry_url:
        AgentID registry base URL.
    refresh_interval:
        Trust-score cache TTL in seconds (default 300).
    **httpx_kwargs:
        Any additional keyword arguments passed to ``httpx.Client()``.

    Returns
    -------
    httpx.Client
        Ready-to-use HTTP client with trust headers wired in.

    Example
    -------
    ::

        client = build_httpx_client("did:agentid:abc123")
        resp = client.post("https://mcp.example.com/tools/call", json={...})
        # Request carries X-AgentID-DID, X-AgentID-Trust-Score, etc.
    """
    import httpx

    inner = httpx.HTTPTransport(**{k: v for k, v in httpx_kwargs.items()
                                   if k in ("verify", "cert", "http1", "http2",
                                            "proxy", "retries", "socket_options",
                                            "uds", "local_address")})
    transport = TrustBriefTransport(
        inner,
        agent_did=agent_did,
        registry_url=registry_url,
        refresh_interval=refresh_interval,
    )
    client_kwargs = {k: v for k, v in httpx_kwargs.items()
                    if k not in ("verify", "cert", "http1", "http2",
                                 "proxy", "retries", "socket_options",
                                 "uds", "local_address")}
    return httpx.Client(transport=transport, **client_kwargs)


def build_async_httpx_client(
    agent_did: str = "",
    *,
    registry_url: str = "",
    refresh_interval: int = 300,
    **httpx_kwargs,
):
    """
    Return a pre-configured ``httpx.AsyncClient`` with trust-brief headers.

    Example
    -------
    ::

        async with build_async_httpx_client("did:agentid:abc123") as client:
            resp = await client.post("https://mcp.example.com/tools/call", json={...})
    """
    import httpx

    inner = httpx.AsyncHTTPTransport(**{k: v for k, v in httpx_kwargs.items()
                                        if k in ("verify", "cert", "http1", "http2",
                                                 "proxy", "retries", "socket_options",
                                                 "uds", "local_address")})
    transport = AsyncTrustBriefTransport(
        inner,
        agent_did=agent_did,
        registry_url=registry_url,
        refresh_interval=refresh_interval,
    )
    client_kwargs = {k: v for k, v in httpx_kwargs.items()
                    if k not in ("verify", "cert", "http1", "http2",
                                 "proxy", "retries", "socket_options",
                                 "uds", "local_address")}
    return httpx.AsyncClient(transport=transport, **client_kwargs)
