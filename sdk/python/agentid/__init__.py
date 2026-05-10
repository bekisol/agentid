"""
AgentID Python SDK — canonical public API.

Exactly 8 exported symbols::

    from agentid import Agent, signed, verify, find, attest, RemoteAgent, Receipt, TrustScore

Quick-start
-----------
Create an agent::

    agent = Agent.create(
        name="my-agent",
        capabilities=["web-search"],
        owner="me@example.com",
        registry_url="https://api.agentid-protocol.com",
    )

Sign a function's output with the @signed decorator::

    from agentid import Agent, signed

    @signed(agent)
    def summarise(text: str) -> str:
        return text[:100]

    receipt = summarise("hello world")
    print(receipt.verify())   # True

Discover agents by capability::

    from agentid import find

    agents = find("web-search", trust_min=0.6,
                  registry_url="https://api.agentid-protocol.com")

Check a trust score::

    from agentid import TrustScore

    ts = TrustScore.fetch(did, registry_url="https://api.agentid-protocol.com")
    print(ts.score, ts.top_3_issues)
"""

from .agent import Agent
from .public_api import Receipt, RemoteAgent, TrustScore, attest, find, signed, verify

__version__ = "0.4.0"

__all__ = [
    "Agent",
    "signed",
    "verify",
    "find",
    "attest",
    "RemoteAgent",
    "Receipt",
    "TrustScore",
]

# Runtime symbols are imported lazily to avoid requiring httpx/asyncio
# at import time for users who only use the identity/crypto layer.
# Access via: from agentid.runtime import AgentRuntime, MessageContext
