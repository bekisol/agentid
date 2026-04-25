"""AgentID integration for LangChain.

Gives any LangChain agent a verifiable cryptographic identity,
and lets agents discover and verify each other at runtime.

    pip install langchain-agentid

Usage::

    from langchain_agentid import (
        AgentIDCallbackHandler,
        AgentIDFindTool,
        AgentIDVerifyTool,
        verify_langchain_output,
    )

"""

from langchain_agentid.callbacks import AgentIDCallbackHandler
from langchain_agentid.tools import AgentIDFindTool, AgentIDSignTool, AgentIDVerifyTool
from langchain_agentid.tools import verify_langchain_output

__version__ = "0.1.0"

__all__ = [
    "AgentIDCallbackHandler",
    "AgentIDFindTool",
    "AgentIDVerifyTool",
    "AgentIDSignTool",
    "verify_langchain_output",
]
