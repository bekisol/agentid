"""AgentID integration for CrewAI.

Gives every CrewAI agent a verifiable cryptographic identity.
Agents can discover each other by capability and verify task outputs.

    pip install crewai-agentid

Usage::

    from crewai_agentid import (
        AgentIDFindTool,
        AgentIDVerifyTool,
        create_agentid_crew_agent,
        AgentIDObserver,
    )

"""

from crewai_agentid.tools import AgentIDFindTool, AgentIDVerifyTool
from crewai_agentid.agent import create_agentid_crew_agent, AgentIDObserver, CrewAgentWithID

__version__ = "0.1.0"

__all__ = [
    "AgentIDFindTool",
    "AgentIDVerifyTool",
    "create_agentid_crew_agent",
    "AgentIDObserver",
    "CrewAgentWithID",
]
