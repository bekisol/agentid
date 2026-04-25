"""Tests for CrewAI AgentID integration."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / "sdk" / "python"))

from crewai_agentid.tools import AgentIDFindTool, AgentIDVerifyTool
from crewai_agentid.agent import create_agentid_crew_agent, AgentIDObserver


# ── AgentIDFindTool ───────────────────────────────────────────────────────────

def test_find_tool_returns_agents(tmp_path):
    from agentid import Agent
    Agent.create("specialist", ["data-analysis"], "u@x.com", registry_path=str(tmp_path))

    tool = AgentIDFindTool(registry_path=str(tmp_path))
    result = json.loads(tool._run("data-analysis"))

    assert len(result) >= 1
    assert any(a["name"] == "specialist" for a in result)


def test_find_tool_no_results(tmp_path):
    tool = AgentIDFindTool(registry_path=str(tmp_path))
    result = tool._run("quantum-teleportation")
    assert "No agents found" in result


def test_find_tool_result_shape(tmp_path):
    from agentid import Agent
    Agent.create("shape-test", ["translation"], "u@x.com", registry_path=str(tmp_path))

    tool = AgentIDFindTool(registry_path=str(tmp_path))
    result = json.loads(tool._run("translation"))
    agent = result[0]

    assert "did" in agent
    assert "name" in agent
    assert "capabilities" in agent
    assert "owner" in agent


def test_find_tool_name_and_description():
    tool = AgentIDFindTool()
    assert tool.name == "AgentID Find"
    assert "capability" in tool.description.lower()


# ── AgentIDVerifyTool ─────────────────────────────────────────────────────────

def test_verify_tool_valid(tmp_path):
    from agentid import Agent
    agent = Agent.create("verify-src", ["ops"], "u@x.com", registry_path=str(tmp_path))
    signed = agent.sign({"task": "done"})

    tool = AgentIDVerifyTool(registry_path=str(tmp_path))
    result = json.loads(tool._run(json.dumps(signed)))

    assert result["valid"] is True
    assert result["signer"] == agent.did


def test_verify_tool_tampered(tmp_path):
    from agentid import Agent
    agent = Agent.create("tamper-src", ["ops"], "u@x.com", registry_path=str(tmp_path))
    signed = agent.sign({"task": "deploy"})
    tampered = {"payload": {**signed["payload"], "task": "destroy"}, "signature": signed["signature"]}

    tool = AgentIDVerifyTool(registry_path=str(tmp_path))
    result = json.loads(tool._run(json.dumps(tampered)))

    assert result["valid"] is False


def test_verify_tool_bad_json(tmp_path):
    tool = AgentIDVerifyTool(registry_path=str(tmp_path))
    assert "Invalid input" in tool._run("not json")


def test_verify_tool_missing_keys(tmp_path):
    tool = AgentIDVerifyTool(registry_path=str(tmp_path))
    assert "Invalid input" in tool._run(json.dumps({"only": "one"}))


# ── create_agentid_crew_agent ─────────────────────────────────────────────────

def test_create_crew_agent_has_did(tmp_path):
    agent = create_agentid_crew_agent(
        role="Senior Researcher",
        goal="Research AI topics",
        backstory="Expert researcher",
        capabilities=["research", "summarization"],
        owner="team@co.com",
        registry_path=str(tmp_path),
        llm=None,
    )
    assert hasattr(agent, "agentid_did")
    assert agent.agentid_did.startswith("did:agentid:")


def test_create_crew_agent_registered(tmp_path):
    from agentid import Agent

    agent = create_agentid_crew_agent(
        role="Code Reviewer",
        goal="Review code quality",
        backstory="Senior engineer",
        capabilities=["code-review"],
        owner="dev@co.com",
        registry_path=str(tmp_path),
        llm=None,
    )

    resolved = Agent.resolve(agent.agentid_did, registry_path=str(tmp_path))
    assert resolved is not None
    assert "code-review" in resolved.capabilities


def test_create_crew_agent_role_as_name(tmp_path):
    agent = create_agentid_crew_agent(
        role="Data Analyst",
        goal="Analyze data",
        backstory="Expert analyst",
        capabilities=["data-analysis"],
        owner="u@co.com",
        registry_path=str(tmp_path),
        llm=None,
    )
    assert agent.agentid.name == "data-analyst"


# ── AgentIDObserver ───────────────────────────────────────────────────────────

def test_observer_sign_and_verify(tmp_path):
    agent = create_agentid_crew_agent(
        role="Writer",
        goal="Write content",
        backstory="Expert writer",
        capabilities=["writing"],
        owner="u@co.com",
        registry_path=str(tmp_path),
        llm=None,
    )
    observer = AgentIDObserver(signing_agent=agent)

    signed = observer.sign_output("The final report is complete.")
    assert observer.verify_output(signed)


def test_observer_did_matches_agent(tmp_path):
    agent = create_agentid_crew_agent(
        role="Analyst",
        goal="Analyse",
        backstory="Expert",
        capabilities=["analysis"],
        owner="u@co.com",
        registry_path=str(tmp_path),
        llm=None,
    )
    observer = AgentIDObserver(signing_agent=agent)
    assert observer.did == agent.agentid_did


def test_observer_sign_task_result(tmp_path):
    agent = create_agentid_crew_agent(
        role="Summarizer",
        goal="Summarize",
        backstory="Expert",
        capabilities=["summarization"],
        owner="u@co.com",
        registry_path=str(tmp_path),
        llm=None,
    )
    observer = AgentIDObserver(signing_agent=agent)
    result = observer.sign_task_result("Summary: AI is advancing rapidly.")
    parsed = json.loads(result)

    assert "payload" in parsed
    assert "signature" in parsed


def test_observer_requires_agentid_agent():
    with pytest.raises(ValueError, match="create_agentid_crew_agent"):
        AgentIDObserver(signing_agent="not a crew agent with id")


def test_full_crew_flow(tmp_path):
    """Simulate a full crew: agent produces output, observer signs, another verifies."""
    from agentid import Agent

    researcher = create_agentid_crew_agent(
        role="Researcher",
        goal="Research topics",
        backstory="Expert",
        capabilities=["research"],
        owner="team@co.com",
        registry_path=str(tmp_path),
        llm=None,
    )
    observer = AgentIDObserver(signing_agent=researcher)

    # Researcher produces output and signs it
    output = "Found 5 relevant papers on AI safety."
    signed = observer.sign_output(output)

    # Any other agent or system can verify
    assert observer.verify_output(signed)

    # Verify via AgentID directly (simulates a different agent verifying)
    valid = Agent.verify_from_did(signed, registry_path=str(tmp_path))
    assert valid
