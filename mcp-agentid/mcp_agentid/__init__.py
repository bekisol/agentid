"""
mcp-agentid — drop-in identity and trust layer for MCP servers.

One decorator gives your MCP tool:
- Caller identity verification (DID-based)
- Trust score enforcement
- Capability gating
- Signed audit log entry per call
- Auto-published capability contract on first call

Quick start::

    from mcp_agentid import secure

    @secure(trust_min=0.6, capabilities=["file-read"])
    def read_file(path: str, *, caller_did: str = None) -> str:
        return open(path).read()

Install::

    pip install mcp-agentid

"""

from .decorator import secure
from .audit import AuditLog
from .trust import get_trust_score, check_trust
from .middleware import (
    TrustBriefTransport,
    AsyncTrustBriefTransport,
    build_trust_headers,
    build_httpx_client,
    build_async_httpx_client,
    HEADER_DID,
    HEADER_TRUST_SCORE,
    HEADER_TRUST_LEVEL,
    HEADER_TRUST_BRIEF,
    HEADER_RISK_BAND,
    HEADER_REGISTRY,
)

__version__ = "0.2.0"

__all__ = [
    "secure",
    "AuditLog",
    "get_trust_score",
    "check_trust",
    "TrustBriefTransport",
    "AsyncTrustBriefTransport",
    "build_trust_headers",
    "build_httpx_client",
    "build_async_httpx_client",
    "HEADER_DID",
    "HEADER_TRUST_SCORE",
    "HEADER_TRUST_LEVEL",
    "HEADER_TRUST_BRIEF",
    "HEADER_RISK_BAND",
    "HEADER_REGISTRY",
]
