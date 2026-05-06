"""
agentid.brain — Autonomous decision-making for AI agents.

The brain enables an agent to:
  1. Observe data sources (git repos, files, HTTP APIs, …)
  2. Judge whether action is required (LLM-powered, OpenAI + Anthropic)
  3. Act autonomously (send messages, find agents, alert owner)
  4. Remember what it has done (persistent JSON memory)
  5. Run continuously on a schedule or when data changes

Quick start
-----------
    from agentid.brain import AgentBrain
    from agentid.brain.perception import GitPerception
    from agentid.brain.triggers import IntervalTrigger

    brain = AgentBrain(
        agent_did="did:agentid:...",
        api_key="agentid_...",
        mission="Watch our repo for security issues and alert the team.",
        anthropic_key="sk-ant-...",
    )
    brain.add_perception(GitPerception(repo_path="/code/myrepo"))
    brain.add_trigger(IntervalTrigger(seconds=3600))

    import asyncio
    asyncio.run(brain.run())
"""

from .brain import AgentBrain
from .memory.store import BrainMemory
from .perception.base import Perception, PerceptionData
from .perception.git import GitPerception
from .perception.files import FilePerception
from .perception.api import APIPerception
from .judgment.engine import JudgmentEngine, JudgmentResult
from .actions.executor import (
    ActionExecutor,
    Action,
    SendMessageAction,
    FindAndContactAction,
    AlertOwnerAction,
    StoreNoteAction,
    parse_action,
)
from .triggers.schedule import IntervalTrigger, DailyTrigger
from .triggers.change import OnChangeTrigger

__all__ = [
    # Core
    "AgentBrain",
    "BrainMemory",
    # Perception
    "Perception",
    "PerceptionData",
    "GitPerception",
    "FilePerception",
    "APIPerception",
    # Judgment
    "JudgmentEngine",
    "JudgmentResult",
    # Actions
    "ActionExecutor",
    "Action",
    "SendMessageAction",
    "FindAndContactAction",
    "AlertOwnerAction",
    "StoreNoteAction",
    "parse_action",
    # Triggers
    "IntervalTrigger",
    "DailyTrigger",
    "OnChangeTrigger",
]
