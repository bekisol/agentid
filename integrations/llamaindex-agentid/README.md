# llamaindex-agentid

[![PyPI version](https://img.shields.io/pypi/v/llamaindex-agentid.svg)](https://pypi.org/project/llamaindex-agentid/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**AgentID identity and trust for LlamaIndex** — sign every query response, discover agents by capability, verify output provenance.

```bash
pip install llamaindex-agentid
```

---

## Query engine wrapper

Wrap any LlamaIndex query engine — every response is automatically signed with your agent's Ed25519 key:

```python
import os
from llama_index.core import VectorStoreIndex, SimpleDirectoryReader
from llamaindex_agentid import AgentIDQueryEngine

documents = SimpleDirectoryReader("data").load_data()
index = VectorStoreIndex.from_documents(documents)

# First run: creates a new identity. Save the DID to an env var.
engine = AgentIDQueryEngine(
    query_engine=index.as_query_engine(),
    name="research-agent",
    capabilities=["research", "summarization"],
    owner="team@company.com",
    registry_url="https://api.agentid-protocol.com",
)
print(f"DID (save this): {engine.did}")

# Subsequent runs: reload the same identity
engine = AgentIDQueryEngine(
    query_engine=index.as_query_engine(),
    did=os.environ["MY_AGENT_DID"],
    name="research-agent",
    capabilities=["research", "summarization"],
    owner="team@company.com",
    registry_url="https://api.agentid-protocol.com",
)

response = engine.query("What are the main AI safety concerns?")
print(response.response)

# Verify the response came from who it claims
assert engine.verify_response(response)  # True

# Or verify from another process using only the DID
from agentid import Agent
Agent.verify_from_did({
    "payload":   response.metadata["_agentid_payload"],
    "signature": response.metadata["_agentid_signature"],
})  # True
```

---

## Agent tools

Add AgentID discovery and verification tools to any LlamaIndex ReAct agent:

```python
from llama_index.core.agent import ReActAgent
from llama_index.llms.openai import OpenAI
from llamaindex_agentid import get_agentid_tools

tools = get_agentid_tools(registry_url="https://api.agentid-protocol.com")

agent = ReActAgent.from_tools(
    tools,
    llm=OpenAI(model="gpt-4o"),
    verbose=True,
)

# The agent can now:
# - Call agentid_find("web-search") to discover other agents
# - Call agentid_verify(signed_message) to verify messages from other agents
response = agent.chat("Find a web-search agent and tell me what it can do")
```

---

## Response metadata

Every response from `AgentIDQueryEngine.query()` includes:

| Key | Description |
|-----|-------------|
| `_agentid_did` | Signer's DID |
| `_agentid_signature` | Base64 Ed25519 signature |
| `_agentid_payload` | Signed payload (pass to `Agent.verify_from_did`) |

---

## License

MIT
