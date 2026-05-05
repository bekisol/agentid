"""AgentID crew agent factory and observer."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger(__name__)


@dataclass
class CrewAgentWithID:
    """Wrapper pairing a CrewAI Agent with its AgentID identity.

    CrewAI's Agent is a frozen Pydantic model — custom fields can't be
    set directly on it. This wrapper holds both objects together cleanly.

    Attributes:
        crew_agent: The underlying crewai.Agent instance.
        agentid:    The agentid.Agent identity instance.

    Access the CrewAI agent for Crew/Task construction::

        crew = Crew(agents=[wrapper.crew_agent], tasks=[task])

    """

    crew_agent: Any
    agentid: Any
    _registry_url: Optional[str] = None
    _registry_path: Optional[str] = None

    @property
    def agentid_did(self) -> str:
        return self.agentid.did

    @property
    def role(self) -> str:
        return self.crew_agent.role


def create_agentid_crew_agent(
    role: str,
    goal: str,
    backstory: str,
    capabilities: list[str],
    owner: str,
    did: Optional[str] = None,
    registry_url: Optional[str] = None,
    registry_path: Optional[str] = None,
    **crewai_kwargs: Any,
) -> "CrewAgentWithID":
    """
    Create a CrewAI Agent with a verifiable AgentID identity.

    The agent is registered in the AgentID registry on creation.
    Its DID is available via agent.agentid_did.

    Usage::

        from crewai_agentid import create_agentid_crew_agent, AgentIDFindTool

        researcher = create_agentid_crew_agent(
            role="Senior Researcher",
            goal="Research the latest developments in AI safety",
            backstory="Expert researcher with 10 years of experience",
            capabilities=["research", "summarization", "fact-checking"],
            owner="team@company.com",
        )

        print(researcher.agentid_did)
        # did:agentid:7sP3V2mNkQxRtYbLcDfHgJwAeUiMoZnXvBqKpTsWyE

    Args:
        role: The agent's role in the crew.
        goal: What the agent is trying to achieve.
        backstory: Background context for the agent.
        capabilities: AgentID capability identifiers for this agent.
        owner: Owner identifier (email or team name).
        registry_url: Remote AgentID registry URL.
        registry_path: Local registry path.
        **crewai_kwargs: Additional kwargs passed to crewai.Agent.

    """
    from crewai import Agent
    from agentid import Agent as AgentIDAgent

    if did:
        agentid = AgentIDAgent.load(
            did,
            registry_url=registry_url,
            registry_path=registry_path,
        )
        logger.info("[AgentID] Crew agent '%s' loaded existing identity: %s", role, agentid.did)
    else:
        agentid = AgentIDAgent.create(
            name=role.lower().replace(" ", "-"),
            capabilities=capabilities,
            owner=owner,
            registry_url=registry_url,
            registry_path=registry_path,
        )
        logger.info("[AgentID] Crew agent '%s' created new identity: %s  (save this DID!)", role, agentid.did)

    # CrewAI's Agent is a frozen Pydantic model — we can't subclass it cleanly.
    # CrewAgentWithID is a thin wrapper: pass wrapper.crew_agent to Crew(agents=[...]).
    # The agentid identity and signing live on the wrapper itself.
    crew_agent = Agent(
        role=role,
        goal=goal,
        backstory=backstory,
        **crewai_kwargs,
    )

    return CrewAgentWithID(
        crew_agent=crew_agent,
        agentid=agentid,
        _registry_url=registry_url,
        _registry_path=registry_path,
    )


class AgentIDObserver:
    """
    Observer that signs crew task outputs and verifies inter-agent messages.

    Attach to a Crew to automatically sign every task output.
    Signed outputs can be verified by any downstream agent or system.

    Usage::

        from crewai import Crew
        from crewai_agentid import AgentIDObserver

        observer = AgentIDObserver(signing_agent=researcher)

        crew = Crew(
            agents=[researcher, writer],
            tasks=[research_task, write_task],
        )

        result = crew.kickoff()
        signed_result = observer.sign_output(str(result))

        # Anyone can verify it
        print(observer.verify_output(signed_result))  # → True

    """

    def __init__(self, signing_agent: Any) -> None:
        if not isinstance(signing_agent, CrewAgentWithID):
            raise ValueError(
                "signing_agent must be created with create_agentid_crew_agent()"
            )
        self._agent = signing_agent.agentid
        self._registry_url = signing_agent._registry_url
        self._registry_path = signing_agent._registry_path

    @property
    def did(self) -> str:
        return self._agent.did

    def sign_output(self, output: str) -> dict:
        """Sign a crew output string. Returns a dict with payload + signature."""
        return self._agent.sign({"output": output, "crew_role": self._agent.name})

    def verify_output(self, signed_output: dict) -> bool:
        """Verify a signed crew output dict."""
        from agentid import Agent
        return Agent.verify_from_did(
            signed_output,
            registry_url=self._registry_url,
            registry_path=self._registry_path,
        )

    def sign_task_result(self, task_output: str) -> str:
        """
        Sign a task result and return it as a JSON string.
        Useful for passing verified results between tasks.
        """
        signed = self.sign_output(task_output)
        return json.dumps(signed)
