"""AgentID integration for AutoGen.

Gives every AutoGen ConversableAgent a verifiable cryptographic identity.
Agents sign every message they send and can verify messages they receive.

    pip install autogen-agentid

Usage::

    from autogen_agentid import AgentIDMixin, create_agentid_agent, verify_autogen_message

"""

from autogen_agentid.agent import AgentIDMixin, create_agentid_agent
from autogen_agentid.verify import verify_autogen_message, extract_signed_payload

__version__ = "0.1.0"

__all__ = [
    "AgentIDMixin",
    "create_agentid_agent",
    "verify_autogen_message",
    "extract_signed_payload",
]
