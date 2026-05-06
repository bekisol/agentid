from .agent import Agent, AgentDocument
from .registry import Registry

__version__ = "0.2.0"
__all__ = ["Agent", "AgentDocument", "Registry"]

# Runtime symbols are imported lazily to avoid requiring httpx/asyncio
# at import time for users who only use the identity/crypto layer.
# Access via: from agentid.runtime import AgentRuntime, MessageContext
