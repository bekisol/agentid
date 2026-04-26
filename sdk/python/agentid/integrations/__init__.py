"""
AgentID framework integrations.

Available:
    agentid.integrations.langchain  — LangChain tools + callback handler
    agentid.integrations.crewai     — CrewAI tools + agent factory
    agentid.integrations.autogen    — AutoGen v0.2 and v0.4+ tools
"""

try:
    from .langchain import (
        AgentIDCallbackHandler,
        AgentIDFindTool,
        AgentIDVerifyTool,
        AgentIDSignTool,
        verify_langchain_output,
    )
    __all__ = [
        "AgentIDCallbackHandler",
        "AgentIDFindTool",
        "AgentIDVerifyTool",
        "AgentIDSignTool",
        "verify_langchain_output",
    ]
except ImportError:
    __all__ = []
