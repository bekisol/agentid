"""
agentid.brain — Autonomous decision-making for AI agents.

The brain enables an agent to observe, research, judge, and act without
human intervention — across any domain, with any AI model.

Architecture
------------
    Provider    → the AI model (Claude, GPT, Gemini, Grok, Mistral, Ollama, …)
    Tools       → what the LLM uses to research (web_search, fetch_url, custom)
    Judgment    → agentic loop: research → decide → output JSON
    Actions     → send messages, find agents, alert owner, store notes
    Perception  → optional structured data sources (git, files, HTTP)
    Memory      → persistent JSON state per agent
    Triggers    → when to run (schedule, on-change)

Quick start
-----------
    from agentid.brain import AgentBrain
    from agentid.brain.providers import AnthropicProvider
    from agentid.brain.tools import WebSearchTool, FetchURLTool
    from agentid.brain.triggers import IntervalTrigger
    import asyncio

    brain = AgentBrain(
        agent_did="did:agentid:...",
        api_key="agentid_...",
        mission="Monitor oil markets. Alert the team if Brent crude moves >3% "
                "or OPEC makes a surprise announcement.",
        provider=AnthropicProvider(api_key="sk-ant-..."),
        tools=[WebSearchTool(api_key="BSA..."), FetchURLTool()],
    )
    brain.memory.set_note("owner_did", "did:agentid:portfolio_manager")
    brain.add_trigger(IntervalTrigger(seconds=3600))

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
from .providers.base import LLMProvider, ProviderResponse, ToolCall
from .providers.anthropic import AnthropicProvider
from .providers.openai import OpenAIProvider
from .providers.gemini import GeminiProvider
from .tools.base import Tool
from .tools.web_search import WebSearchTool
from .tools.fetch_url import FetchURLTool
from .tools.mcp import MCPSession, MCPProxyTool

__all__ = [
    # Core
    "AgentBrain",
    "BrainMemory",
    # Providers
    "LLMProvider",
    "ProviderResponse",
    "ToolCall",
    "AnthropicProvider",
    "OpenAIProvider",
    "GeminiProvider",
    # Tools
    "Tool",
    "WebSearchTool",
    "FetchURLTool",
    "MCPSession",
    "MCPProxyTool",
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
