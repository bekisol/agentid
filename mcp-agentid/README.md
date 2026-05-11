# mcp-agentid

**Drop-in identity and trust layer for MCP servers.**  
One decorator. Verified caller DIDs. Trust score gating. Append-only audit logs.

[![PyPI](https://img.shields.io/pypi/v/mcp-agentid)](https://pypi.org/project/mcp-agentid/)
[![Python](https://img.shields.io/pypi/pyversions/mcp-agentid)](https://pypi.org/project/mcp-agentid/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://github.com/agentid-protocol/agentid/actions/workflows/ci.yml/badge.svg)](https://github.com/agentid-protocol/agentid/actions)

---

## Install

```bash
pip install mcp-agentid
```

That's it. No broker to run. No certificates to manage.

---

## 30-second example

```python
from mcp_agentid import secure

@secure(trust_min=0.6, capabilities=["file-read"])
def read_file(path: str, *, caller_did: str = None) -> str:
    """Return the contents of a file."""
    with open(path) as f:
        return f.read()
```

Every call to `read_file` now:

1. **Verifies** the caller's DID against the AgentID registry
2. **Gates** on trust score ≥ 60/100 and `file-read` capability
3. **Logs** the outcome to an append-only JSONL audit trail
4. **Returns** the result unchanged — no wrapper, no format change

Anonymous callers (no `caller_did`) pass through by default. Set `allow_anonymous=False` to require verified identity on every call.

---

## How it works

### Caller identity — `did:agentid`

Every AI agent that wants to call your MCP tools registers a **Decentralized Identifier** (DID) with the AgentID registry:

```
did:agentid:7mK9xR2pQnFvLsB3YhTcWjAeXdUoNgZi
```

The DID is derived from an Ed25519 public key — no central authority, no password, no account. The agent signs every message with its private key. The registry stores the public key and computes a trust score from on-chain evidence.

Your MCP middleware passes the caller's DID to your tool function as `caller_did`. `@secure` does the rest.

### Trust score — `0`–`100`

The trust score is a composite of six dimensions:

| Dimension | What it measures |
|-----------|-----------------|
| **D1** Identity Integrity | Key age, rotation history, signing compliance |
| **D2** Operational Reliability | Uptime, task completion rate, SLA history |
| **D3** Network Reputation | Cross-owner peer attestations, PageRank in endorsement graph |
| **D4** Behavioral History | Interaction quality, scope violations (decay-weighted 90d) |
| **D5** Governance | Compliance badge, published capability contracts, scope declaration |
| **D6** Capability Trust | Per-capability peer attestations + call success rate |

`trust_min=0.6` means 60/100 — roughly "established, no red flags."  
`trust_min=0.8` means 80/100 — "well-attested, strong governance."

### Audit log — JSONL

Every call writes one line to `~/.agentid/audit.jsonl` (override with `AGENTID_AUDIT_LOG`):

```json
{"ts": "2026-05-09T12:00:01Z", "tool": "read_file", "caller_did": "did:agentid:7mK9...", "trust_score": 74.2, "outcome": "success", "latency_ms": 3.1}
{"ts": "2026-05-09T12:00:08Z", "tool": "write_config", "caller_did": "did:agentid:low9...", "trust_score": 22.0, "outcome": "permission_denied", "latency_ms": 18.4, "error": "Trust score 22.0/100 below required 60.0/100. Issues: Key not rotated in 87 days (D1 −12), 3 unresolved complaints (D3 −18)"}
```

Thread-safe. Append-only. One JSON object per line. Never rotated or truncated by `mcp-agentid`.

---

## `@secure` — full API

```python
@secure(
    trust_min=0.6,            # minimum trust score (0.0–1.0)
    capabilities=["file-read"],  # caller must declare these capabilities
    registry_url=None,        # defaults to AGENTID_REGISTRY_URL env var
    sign_response=False,      # wrap return value in a signed receipt envelope
    audit=True,               # write JSONL audit log entry on every call
    allow_anonymous=True,     # allow calls with no caller_did
)
def my_tool(arg: str, *, caller_did: str = None) -> str:
    ...
```

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `trust_min` | `float` | `0.0` | Minimum trust score (0 = any verified agent, 1.0 = perfect score). Set to `0.6` for production tools. |
| `capabilities` | `list[str]` | `None` | Capability strings the caller must have declared on their agent profile. |
| `registry_url` | `str` | env var | AgentID registry base URL. Defaults to `AGENTID_REGISTRY_URL`. |
| `sign_response` | `bool` | `False` | Wrap the return value in a crypto-agility signed receipt (requires `[signing]` extra and env vars). |
| `audit` | `bool` | `True` | Write one JSONL audit entry per call. |
| `allow_anonymous` | `bool` | `True` | Allow calls with no `caller_did`. Set to `False` to require verified identity on every call. |

### Exceptions raised

| Exception | When |
|-----------|------|
| `PermissionError` | Caller DID fails trust threshold or missing capabilities |
| `ValueError` | `allow_anonymous=False` and `caller_did` is None |

Both exceptions are caught by `@secure`, logged as `permission_denied`, and re-raised. Your tool function is never called.

---

## Trust levels at a glance

| Score | Level | `trust_min` equivalent | Meaning |
|-------|-------|------------------------|---------|
| 0–29 | `unverified` | — | New or flagged agent — use with caution |
| 30–59 | `basic` | `0.3` | Some history, limited attestations |
| 60–79 | `good` | `0.6` | Established agent, no red flags ✓ |
| 80–89 | `trusted` | `0.8` | Well-attested, strong operational record |
| 90–100 | `verified` | `0.9` | Compliance badge + full governance stack |

The trust score also returns `top_3_issues` — the biggest gaps explained in plain English:

```json
"top_3_issues": [
  "Key not rotated in 87 days (D1 −12)",
  "3 unresolved complaints (D3 −18)",
  "No SLA data on file (D2 −5)"
]
```

These are logged on `permission_denied` so you always know exactly why a caller was blocked.

---

## Advanced usage

### Require a verified DID (no anonymous callers)

```python
@secure(trust_min=0.7, allow_anonymous=False)
def delete_records(table: str, *, caller_did: str = None) -> dict:
    """High-risk operation — verified callers only."""
    ...
```

### Sign your responses (optional)

Wrap the return value in an Ed25519 receipt so the caller can prove they received a genuine result:

```bash
pip install mcp-agentid[signing]
```

```python
import os
os.environ["AGENTID_AGENT_DID"]   = "did:agentid:your_server_did"
os.environ["AGENTID_PRIVATE_KEY"] = "your_hex_private_key"

@secure(sign_response=True)
def query(sql: str, *, caller_did: str = None) -> list:
    ...
```

The response becomes:

```json
{
  "result": [...],
  "signed": true,
  "signer": "did:agentid:your_server_did",
  "timestamp": 1746796800,
  "nonce": "a3f8c21e94b7056d",
  "signature": {
    "algSuite": "ed25519-sha512-2024",
    "version": 1,
    "params": {},
    "signature": "X7kQ..."
  }
}
```

### Read the audit log programmatically

```python
from mcp_agentid import AuditLog

log = AuditLog("~/.agentid/audit.jsonl")
recent = log.tail(50)      # last 50 entries as parsed dicts
for entry in recent:
    print(entry["caller_did"], entry["outcome"], entry["tool"])
```

### Check trust without `@secure`

```python
from mcp_agentid import get_trust_score, check_trust

# Fetch trust score (5-minute cache)
score = get_trust_score("did:agentid:abc123")
print(score["score"], score["level"], score["top_3_issues"])

# Gate on trust — raises PermissionError if below threshold
check_trust(
    "did:agentid:abc123",
    trust_min=0.6,
    capabilities=["database-write"],
)
```

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENTID_REGISTRY_URL` | Yes (for trust checks) | Base URL of your AgentID registry. Example: `https://api.agentid-protocol.com` |
| `AGENTID_AUDIT_LOG` | No | Path to audit log file. Default: `~/.agentid/audit.jsonl` |
| `AGENTID_AGENT_DID` | Only if `sign_response=True` | DID of this MCP server. |
| `AGENTID_PRIVATE_KEY` | Only if `sign_response=True` | Hex-encoded Ed25519 private key for response signing. |

---

## Comparison

| Feature | No auth | OAuth 2.1 | A2A / ANP / DPoP | **mcp-agentid** |
|---------|---------|-----------|-------------------|----------------|
| Caller identity | ✗ None | Token (opaque) | Token (opaque) | **DID — cryptographic, self-sovereign** |
| Trust score | ✗ | ✗ | ✗ | **0–100 composite + top_3_issues** |
| Capability gating | ✗ | Scopes (static) | Scopes (static) | **Declared + attested capabilities** |
| Audit trail | ✗ | Depends on server | Depends on server | **Append-only JSONL, always** |
| Signed responses | ✗ | ✗ | ✗ | **Ed25519 receipt (optional)** |
| Broker required | — | Yes (auth server) | Yes (auth server) | **No — registry is read-only** |
| Works offline | — | ✗ | ✗ | **Partial (cached trust scores)** |
| Setup time | — | Hours–days | Hours–days | **One decorator + env var** |
| Cross-owner trust | — | ✗ | ✗ | **Yes — D3 Network Reputation** |
| Protocol | — | RFC 6749/9068 | Draft specs | **did:agentid + Ed25519** |

---

## Running tests

```bash
pip install -e ".[dev]"
pytest tests/ -v
```

17 tests covering: decorator metadata, trust pass/block, anonymous gating, audit log JSONL format, capability checks, response signing, and edge cases.

---

## Integration with MCP middleware

Your MCP framework needs to pass the caller's DID to tool functions. Add `caller_did` extraction to your request middleware:

```python
# Example: FastAPI MCP server middleware
from fastapi import Request

async def extract_caller_did(request: Request) -> str | None:
    """Extract and validate caller DID from X-AgentID-DID header."""
    did = request.headers.get("X-AgentID-DID")
    sig = request.headers.get("X-AgentID-Signature")
    if did and sig:
        # Verify the signature over the request body
        # (use agentid-protocol SDK verify() function)
        return did
    return None
```

Then inject it as `caller_did=` when calling your tool functions.

---

## Related

- **[agentid-protocol](https://pypi.org/project/agentid-protocol/)** — Full Python SDK for agent identity, signing, and discovery (`Agent, signed, verify, find, attest, RemoteAgent, Receipt, TrustScore`)
- **[AgentID Registry](https://api.agentid-protocol.com)** — Hosted DID registry and trust score service
- **[W3C DID Core](https://www.w3.org/TR/did-core/)** — The DID standard mcp-agentid is built on

---

## License

MIT — see [LICENSE](LICENSE).
