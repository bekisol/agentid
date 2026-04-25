# community: add AgentID integration for agent identity and discovery

## The problem

Multi-agent LangChain systems have no standard way to:

1. **Identify agents** — who produced this output? Every team rolls their own auth.
2. **Discover agents** — which agents can do X? Hardcoded URLs or manual configuration.
3. **Verify messages** — did this output actually come from the agent it claims? No signing standard.

As multi-agent systems grow in complexity, this becomes a critical gap. An agent executor
calling a subagent has no way to cryptographically verify the response came from a trusted source.

## What this PR adds

Integration with [AgentID](https://github.com/agentid/agentid) — an open protocol for AI agent
identity, discovery, and trust built on Ed25519 cryptography and W3C DID standards.

### `AgentIDCallbackHandler`

Attaches a verifiable identity to any LangChain agent. Cryptographically signs every output.

```python
from langchain_community.callbacks import AgentIDCallbackHandler

identity = AgentIDCallbackHandler(
    name="research-agent",
    capabilities=["web-search", "summarization"],
    owner="team@company.com",
)
print(identity.did)
# did:agentid:7sP3V2mNkQxRtYbLcDfHgJwAeUiMoZnXvBqKpTsWyE

executor = AgentExecutor(agent=agent, tools=tools, callbacks=[identity])
result = executor.invoke({"input": "Research AI safety papers"})

# Every output is automatically signed — verify it downstream
from langchain_community.tools.agentid.tool import verify_langchain_output
verify_langchain_output(result)  # → True
```

### `AgentIDFindTool`

Lets agents discover other agents by capability at runtime.

```python
from langchain_community.tools import AgentIDFindTool

tool = AgentIDFindTool()
tool.invoke("web-search")
# '[{"did": "did:agentid:...", "name": "search-agent", "capabilities": ["web-search"]}]'
```

### `AgentIDVerifyTool`

Lets agents verify that a message genuinely came from the agent it claims.

```python
from langchain_community.tools import AgentIDVerifyTool

tool = AgentIDVerifyTool()
tool.invoke(json.dumps(signed_message))
# '{"valid": true, "signer": "did:agentid:...", "message": "Signature is valid."}'
```

### Full example

```python
from langchain.agents import AgentExecutor, create_react_agent
from langchain_community.callbacks import AgentIDCallbackHandler
from langchain_community.tools import AgentIDFindTool, AgentIDVerifyTool

# Give the agent an identity
identity = AgentIDCallbackHandler(
    name="orchestrator",
    capabilities=["orchestration", "planning"],
    owner="team@company.com",
    registry_url="http://your-registry.com",  # shared across your agent fleet
)

# Add discovery + verification tools
tools = [
    AgentIDFindTool(registry_url="http://your-registry.com"),
    AgentIDVerifyTool(registry_url="http://your-registry.com"),
    # ... your other tools
]

executor = AgentExecutor(agent=agent, tools=tools, callbacks=[identity])

# The agent can now:
# 1. Find other agents: agentid_find("flight-search") → list of agents
# 2. Verify their outputs: agentid_verify(signed_msg) → {valid: true}
# 3. Produce signed outputs that downstream agents can verify
```

## Files changed

```
langchain_community/callbacks/agentid_callback.py   ← AgentIDCallbackHandler
langchain_community/tools/agentid/__init__.py        ← exports
langchain_community/tools/agentid/tool.py            ← 3 tools + verify helper
tests/unit_tests/callbacks/test_agentid_callback.py  ← callback tests
tests/unit_tests/tools/test_agentid_tools.py         ← tool tests
```

## Dependencies

`agentid` is an optional dependency — all imports are guarded with helpful error messages.
No changes to existing dependencies.

```
pip install agentid   # installs: cryptography, base58, httpx, pydantic
```

## Tests

All tests mock `agentid` — no network calls, no API keys, no external services required.

```bash
pytest tests/unit_tests/callbacks/test_agentid_callback.py
pytest tests/unit_tests/tools/test_agentid_tools.py
```

## About AgentID

AgentID is an open protocol — MIT licensed, no vendor lock-in.

- Protocol spec: Ed25519 signatures, W3C DID format (`did:agentid:<base58-public-key>`)
- Local registry (dev): zero config, stores to `~/.agentid/`
- Remote registry (prod): self-hosted FastAPI server, federated
- Python SDK: `pip install agentid`
- TypeScript SDK: coming shortly

The goal is for AgentID to become the default identity layer across all major agent
frameworks — the same way HTTPS became the default transport. Framework integrations
are the fastest path to that standard.

Related: AutoGen PR #[pending], CrewAI PR #[pending]

## Checklist

- [x] New feature (non-breaking)
- [x] Tests added
- [x] All imports are optional with clear error messages
- [x] Docstrings follow LangChain format with Setup/Instantiate/Use sections
- [x] No new required dependencies
