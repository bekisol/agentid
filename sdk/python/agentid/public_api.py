"""
AgentID public API — canonical 8-symbol surface.

Importable as::

    from agentid import Agent, signed, verify, find, attest, RemoteAgent, Receipt, TrustScore

Design goals
------------
- Drop-in usable without understanding the full protocol
- Every function has a teaching error message when used incorrectly
- All types are dataclasses — serialisable, introspectable, no magic
- Network calls are lazy — ``find()`` / ``attest()`` go to the HTTP registry
  only when a ``registry_url`` is supplied
"""

from __future__ import annotations

import functools
import time
from dataclasses import dataclass, field
from typing import Any, Callable


# ── typed result types ────────────────────────────────────────────────────────

@dataclass
class Receipt:
    """
    A signed result envelope returned by :func:`signed`-decorated functions
    and by :meth:`Agent.sign`.

    Attributes
    ----------
    value:      The original return value of the decorated function.
    signature:  Crypto-agility envelope — ``{"algSuite", "version", "params", "signature"}``.
    signer:     DID of the signing agent.
    timestamp:  Unix seconds at signing time.
    nonce:      UUID nonce for replay protection.

    Example::

        receipt = my_agent.sign({"output": "hello"})
        # receipt is a plain dict — verify it with verify()
    """
    value:     Any
    signature: dict      # crypto-agility envelope
    signer:    str       # DID
    timestamp: int       # Unix seconds
    nonce:     str = ""

    def verify(self) -> bool:
        """
        Cryptographically verify this receipt using the signer's public key.

        Requires the signer's DID to be resolvable from the local registry.
        For remote registry verification, use the top-level :func:`verify` function
        with ``registry_url=`` set.

        Returns True if valid, False otherwise.
        """
        from .agent import Agent
        from .crypto import verify as crypto_verify
        from .identity import b64_to_public_key_bytes

        doc = Agent.resolve(self.signer)
        if doc is None:
            raise LookupError(
                f"Could not resolve DID {self.signer!r} from the local registry. "
                "Pass registry_url= to verify() for remote resolution."
            )
        pub_bytes = b64_to_public_key_bytes(doc.public_key)
        payload = {
            "output":    self.value,
            "signer":    self.signer,
            "timestamp": self.timestamp,
            "nonce":     self.nonce,
        }
        return crypto_verify(pub_bytes, payload, self.signature)


@dataclass
class TrustScore:
    """
    Trust score response from the AgentID registry.

    Attributes
    ----------
    did:          DID of the scored agent.
    score:        Composite 0–100 trust score.
    level:        Human label — "low" | "moderate" | "good" | "excellent".
    top_3_issues: Up to 3 strings describing the biggest score gaps.
    dimensions:   Full 6-dimension breakdown (only populated when ``detailed=True``).

    Example::

        ts = TrustScore.fetch("did:agentid:...", registry_url="https://api.agentid-protocol.com")
        if ts.score < 60:
            raise PermissionError(f"Agent trust too low: {ts.top_3_issues}")
    """
    did:          str
    score:        float
    level:        str
    top_3_issues: list[str] = field(default_factory=list)
    dimensions:   dict      = field(default_factory=dict)
    breakdown:    dict      = field(default_factory=dict)

    @classmethod
    def fetch(
        cls,
        did: str,
        registry_url: str = None,
        detailed: bool = False,
    ) -> "TrustScore":
        """
        Fetch the trust score for *did* from an HTTP registry.

        Parameters
        ----------
        did:          DID to look up.
        registry_url: Base URL of the AgentID registry (e.g. "https://api.agentid-protocol.com").
                      Reads ``AGENTID_REGISTRY_URL`` env var as fallback.
        detailed:     Pass True to also fetch the ``dimensions`` and ``breakdown`` fields.

        Raises
        ------
        LookupError:  DID not found or registry unreachable.
        RuntimeError: No registry URL configured.

        Example::

            ts = TrustScore.fetch("did:agentid:...", registry_url="https://api.agentid-protocol.com")
        """
        import os
        import urllib.request
        import json as _json

        url = registry_url or os.environ.get("AGENTID_REGISTRY_URL", "")
        if not url:
            raise RuntimeError(
                "No registry URL provided. Pass registry_url= or set AGENTID_REGISTRY_URL. "
                "Example: TrustScore.fetch(did, registry_url='https://api.agentid-protocol.com')"
            )
        url = url.rstrip("/")
        endpoint = f"{url}/agents/{did}/trust-score"
        if detailed:
            endpoint += "?detailed=true"

        try:
            with urllib.request.urlopen(endpoint, timeout=10) as resp:
                data = _json.loads(resp.read())
        except Exception as exc:
            raise LookupError(
                f"Could not fetch trust score for {did!r} from {url}. "
                f"Check that the DID is registered and the registry URL is correct. Error: {exc}"
            ) from exc

        if "error" in data:
            raise LookupError(
                f"Registry returned error for {did!r}: {data['error']}. "
                "Check that the agent is registered and not private."
            )

        return cls(
            did=data.get("did", did),
            score=float(data.get("score", 0)),
            level=data.get("level", "unknown"),
            top_3_issues=data.get("top_3_issues", []),
            dimensions=data.get("dimensions", {}),
            breakdown=data.get("breakdown", {}),
        )


@dataclass
class RemoteAgent:
    """
    A read-only handle for an agent discovered via :func:`find`.

    Use this to verify receipts from, or call capabilities on, an agent you
    don't own.

    Attributes
    ----------
    did:          DID of the discovered agent.
    name:         Display name.
    trust_score:  Cached trust score at discovery time (0–100).
    capabilities: List of declared capability strings.
    registry_url: Registry the agent was discovered from.

    Example::

        agents = find("web-search", trust_min=0.6,
                      registry_url="https://api.agentid-protocol.com")
        for a in agents:
            print(a.did, a.trust_score)
    """
    did:          str
    name:         str
    trust_score:  float
    capabilities: list[str]   = field(default_factory=list)
    registry_url: str         = ""

    def verify(self, receipt: dict) -> bool:
        """
        Verify a signed message from this agent.

        Parameters
        ----------
        receipt:  Dict with ``payload`` and ``signature`` keys, as returned by
                  :meth:`Agent.sign`.

        Returns True if the signature is valid and not replayed (< 5 minutes old).

        Example::

            msg = remote.verify(signed_message)
        """
        from .agent import Agent
        return Agent.verify_from_did(
            receipt,
            registry_url=self.registry_url or None,
        )


# ── top-level convenience functions ─────────────────────────────────────────


def signed(agent: "Agent") -> Callable:
    """
    Decorator factory — wraps any function so its return value is automatically
    signed by *agent* and returned as a :class:`Receipt`.

    Usage::

        from agentid import Agent, signed

        my_agent = Agent.load("did:agentid:...", registry_url="https://api.agentid-protocol.com")

        @signed(my_agent)
        def summarise(text: str) -> str:
            return text[:100]

        receipt = summarise("hello world")
        print(receipt.signer, receipt.value)
        print(receipt.verify())   # True

    The decorator preserves the original function's docstring and name
    (``functools.wraps``).
    """
    def decorator(fn: Callable) -> Callable:
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            result = fn(*args, **kwargs)
            import uuid as _uuid
            nonce = str(_uuid.uuid4())
            ts = int(time.time())
            from .crypto import sign as _sign
            payload = {
                "output":    result,
                "signer":    agent.did,
                "timestamp": ts,
                "nonce":     nonce,
            }
            envelope = _sign(agent._private_key, payload)
            return Receipt(
                value=result,
                signature=envelope,
                signer=agent.did,
                timestamp=ts,
                nonce=nonce,
            )
        return wrapper
    return decorator


def verify(
    receipt: "dict | Receipt",
    *,
    registry_url: str = None,
    registry_path: str = None,
    trust_min: float = 0.0,
    max_age_seconds: int = 300,
) -> bool:
    """
    Verify a signed receipt or signed message dict.

    Accepts either a :class:`Receipt` dataclass or a plain ``{"payload": ..., "signature": ...}``
    dict as returned by :meth:`Agent.sign`.

    Parameters
    ----------
    receipt:         The signed object to verify.
    registry_url:    HTTP registry base URL for DID resolution.
    registry_path:   Local registry path (for offline use).
    trust_min:       If > 0, also fetch the signer's trust score and reject if below threshold.
    max_age_seconds: Reject signatures older than this many seconds (default 300 / 5 min).

    Returns True if valid, False otherwise.

    Example::

        ok = verify(signed_msg, registry_url="https://api.agentid-protocol.com", trust_min=0.6)
    """
    from .agent import Agent

    # Normalise Receipt → plain signed-message dict
    if isinstance(receipt, Receipt):
        msg = {
            "payload": {
                "output":    receipt.value,
                "signer":    receipt.signer,
                "timestamp": receipt.timestamp,
                "nonce":     receipt.nonce,
            },
            "signature": receipt.signature,
        }
    else:
        msg = receipt

    sig_ok = Agent.verify_from_did(
        msg,
        registry_url=registry_url,
        registry_path=registry_path,
        max_age_seconds=max_age_seconds,
    )
    if not sig_ok:
        return False

    if trust_min > 0.0:
        signer_did = msg.get("payload", {}).get("signer", "")
        if not signer_did:
            return False
        try:
            ts = TrustScore.fetch(signer_did, registry_url=registry_url)
            if ts.score < trust_min * 100:
                return False
        except Exception:
            # If trust score is unreachable, fail closed when trust_min > 0
            return False

    return True


def find(
    capability: str = None,
    *,
    owner: str = None,
    name: str = None,
    trust_min: float = 0.0,
    registry_url: str = None,
    registry_path: str = None,
) -> list[RemoteAgent]:
    """
    Discover agents by capability (and optionally owner or name).

    Parameters
    ----------
    capability:   Capability string to search for (e.g. ``"web-search"``).
    owner:        Filter by owner email or ID.
    name:         Filter by agent name (substring match).
    trust_min:    Minimum trust score (0.0–1.0). Agents below this threshold
                  are excluded. Requires an HTTP registry.
    registry_url: HTTP registry base URL.
    registry_path: Local registry path (for offline use).

    Returns a list of :class:`RemoteAgent` instances, sorted by trust score descending.

    Example::

        agents = find("web-search", trust_min=0.6,
                      registry_url="https://api.agentid-protocol.com")
    """
    from .agent import Agent

    docs = Agent.find(
        capability=capability,
        owner=owner,
        name=name,
        registry_url=registry_url,
        registry_path=registry_path,
    )

    agents = []
    for doc in docs:
        ts_score = 0.0
        if trust_min > 0.0 and registry_url:
            try:
                ts = TrustScore.fetch(doc.did, registry_url=registry_url)
                ts_score = ts.score / 100.0  # normalise to 0-1
                if ts_score < trust_min:
                    continue
            except Exception:
                # Can't fetch trust score — skip if trust_min is required
                continue
        agents.append(RemoteAgent(
            did=doc.did,
            name=doc.name,
            trust_score=ts_score,
            capabilities=doc.capabilities,
            registry_url=registry_url or "",
        ))

    agents.sort(key=lambda a: a.trust_score, reverse=True)
    return agents


def attest(
    agent: "Agent",
    target_did: str,
    claim: str,
    registry_url: str = None,
) -> Receipt:
    """
    Submit a signed peer attestation about *target_did*.

    The attestation is signed with *agent*'s private key and submitted to the
    HTTP registry.  A :class:`Receipt` is returned containing the signed payload
    and the registry's confirmation.

    Parameters
    ----------
    agent:        The attesting agent (must have a private key loaded).
    target_did:   DID of the agent being attested.
    claim:        Short claim string (e.g. ``"confirmed"`` | ``"partial"`` | ``"not_demonstrated"``).
    registry_url: HTTP registry base URL.

    Returns a :class:`Receipt` for the submitted attestation.

    Raises
    ------
    RuntimeError: Agent has no private key.
    ValueError:   Registry URL required (attestations cannot be stored locally).

    Example::

        receipt = attest(my_agent, "did:agentid:...", "confirmed",
                         registry_url="https://api.agentid-protocol.com")
    """
    if agent._private_key is None:
        raise RuntimeError(
            "This agent has no private key and cannot sign attestations. "
            "Load with Agent.load(did, registry_url=...) to get an agent with its key."
        )
    if not registry_url:
        raise ValueError(
            "attest() requires an HTTP registry so the attestation can be stored. "
            "Pass registry_url='https://api.agentid-protocol.com'"
        )

    import time as _time
    import uuid as _uuid
    from .crypto import sign as _sign

    ts = int(_time.time())
    nonce = str(_uuid.uuid4())
    payload = {
        "attester":  agent.did,
        "target":    target_did,
        "claim":     claim,
        "timestamp": ts,
        "nonce":     nonce,
    }
    envelope = _sign(agent._private_key, payload)

    # Submit to registry via HTTP
    import json as _json
    import urllib.request as _req
    url = registry_url.rstrip("/") + f"/agents/{target_did}/attest"
    body = _json.dumps({
        "attester_did": agent.did,
        "claim":        claim,
        "payload":      payload,
        "signature":    envelope,
    }).encode()
    try:
        request = _req.Request(url, data=body, method="POST",
                               headers={"Content-Type": "application/json"})
        with _req.urlopen(request, timeout=10) as resp:
            _json.loads(resp.read())   # read confirmation (ignored for now)
    except Exception as exc:
        raise LookupError(
            f"Failed to submit attestation to {url}: {exc}. "
            "Check that the registry URL is correct and the target DID exists."
        ) from exc

    return Receipt(
        value={"attester": agent.did, "target": target_did, "claim": claim},
        signature=envelope,
        signer=agent.did,
        timestamp=ts,
        nonce=nonce,
    )
