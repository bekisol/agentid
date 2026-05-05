# AgentID

[![PyPI version](https://img.shields.io/pypi/v/agentid-protocol.svg)](https://pypi.org/project/agentid-protocol/)
[![PyPI downloads](https://img.shields.io/pypi/dm/agentid-protocol.svg)](https://pypi.org/project/agentid-protocol/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python 3.8+](https://img.shields.io/badge/python-3.8+-blue.svg)](https://www.python.org/downloads/)

**Identity, discovery, and trust for AI agents.**

The internet was built for humans. AI agents have no standard way to identify themselves, find each other, or verify that messages are genuine. AgentID is the missing protocol layer.

```python
from agentid import Agent

# Every agent gets a cryptographic identity
agent = Agent.create(
    name="research-agent",
    capabilities=["web-search", "summarization"],
    owner="team@company.com",
    registry_url="https://api.agentid-protocol.com",
)
print(agent.did)
# did:agentid:7sP3V2mNkQxRtYbLcDfHgJwAeUiMoZnXvBqKpTsWyE

# Find agents by what they can do
results = Agent.find(capability="web-search", registry_url="https://api.agentid-protocol.com")

# Sign and verify messages between agents
signed = agent.sign({"task": "summarize this document"})
Agent.verify_from_did(signed)  # → True
```

---

## What it solves

Multi-agent systems break down without trust infrastructure:

- **Who is this agent?** No standard identity — every team hand-rolls auth
- **Which agent can do X?** No discovery — agents are hardcoded or manually configured
- **Did this message come from who it claims?** No signing — outputs can be spoofed or tampered

AgentID fixes all three with a single open protocol.

---

## Installation

> **macOS users:** use `pip3` instead of `pip` if `pip` is not found.

```bash
pip3 install agentid-protocol
```

For the LangChain integration:

```bash
pip3 install agentid-protocol langchain-agentid
```

For AutoGen:

```bash
pip3 install agentid-protocol autogen-agentid
```

For CrewAI:

```bash
pip3 install agentid-protocol crewai-agentid
```

---

## Core concepts

### Identity

Every agent gets a **DID (Decentralized Identifier)** derived from an Ed25519 keypair:

```
did:agentid:<base58-encoded-public-key>
```

No central authority issues it. Any agent generates one instantly, offline.

### Capabilities

Agents declare what they can do using string identifiers:

```python
capabilities=["web-search", "code-review", "translation"]
```

### Registry

A registry stores agent documents and makes them discoverable. Use the hosted registry or run your own.

### Signed messages

Every agent can sign payloads. Any third party can verify a signature using only the signer's DID — no shared secrets, no central authority.

---

## Usage

### Local registry (dev, no server needed)

```python
from agentid import Agent

# Create
agent = Agent.create(
    name="my-agent",
    capabilities=["search", "summarize"],
    owner="you@company.com",
)

# Discover
agents = Agent.find(capability="search")

# Resolve a DID
doc = Agent.resolve("did:agentid:...")

# Sign
signed = agent.sign({"task": "analyze this dataset"})

# Verify
Agent.verify_from_did(signed)  # → True
```

### Remote registry (production, shared across machines)

Use the hosted public registry or run your own:

```python
REGISTRY_URL = "https://api.agentid-protocol.com"

agent = Agent.create(
    name="my-agent",
    capabilities=["search"],
    owner="you@company.com",
    registry_url=REGISTRY_URL,
)

agents = Agent.find(capability="search", registry_url=REGISTRY_URL)
```

### Load an existing agent

```python
# Load by DID — private key is stored locally in ~/.agentid/keys/
agent = Agent.load("did:agentid:...")
signed = agent.sign({"task": "run pipeline"})
```

---

## LangChain integration

Give any LangChain agent a verifiable identity and agent-discovery tools:

```python
import os
from agentid.integrations.langchain import (
    load_or_create,
    AgentIDCallbackHandler,
    AgentIDFindTool,
    AgentIDVerifyTool,
)

# First run — creates a new identity. Save the printed DID to an env var.
identity = load_or_create(
    name="research-agent",
    capabilities=["web-search", "summarization"],
    owner="team@company.com",
    registry_url="https://api.agentid-protocol.com",
)
print(f"DID (save this): {identity.did}")

# Subsequent runs — reload the same identity by DID
identity = load_or_create(
    did=os.environ["MY_AGENT_DID"],
    name="research-agent",           # ignored when did is given
    capabilities=["web-search"],     # ignored when did is given
    owner="team@company.com",
    registry_url="https://api.agentid-protocol.com",
)

# 1. Attach identity — signs every final output automatically
handler = AgentIDCallbackHandler(identity)

# 2. Add discovery + verification tools
tools = [
    AgentIDFindTool(registry_url="https://api.agentid-protocol.com"),
    AgentIDVerifyTool(registry_url="https://api.agentid-protocol.com"),
    # ...your other tools
]

# 3. Wire up
executor = AgentExecutor(agent=agent, tools=tools, callbacks=[handler])

# Every output is signed — verify downstream:
result = executor.invoke({"input": "Research the latest AI papers"})
# result["_agentid_did"]       → signer's DID
# result["_agentid_signature"] → Ed25519 signature
# result["_agentid_payload"]   → signed payload (verify with Agent.verify_from_did)
```

---

## AutoGen integration

Works with both AutoGen v0.2.x (`pyautogen`) and v0.4+ (`autogen-agentchat`):

```python
import os
from agentid.integrations.autogen import AgentIDTools, load_or_create

# First run — create identity, save the DID
identity = load_or_create(
    name="my-autogen-agent",
    capabilities=["data-analysis", "code-execution"],
    owner="team@company.com",
    registry_url="https://api.agentid-protocol.com",
)
print(f"DID (save this): {identity.did}")

# Subsequent runs — reload
identity = load_or_create(
    did=os.environ["MY_AGENT_DID"],
    name="my-autogen-agent",
    capabilities=["data-analysis"],
    owner="team@company.com",
    registry_url="https://api.agentid-protocol.com",
)

agentid = AgentIDTools(
    registry_url="https://api.agentid-protocol.com",
    agent=identity,   # enables the sign tool
)

# AutoGen v0.2 — register as function tools on assistant + user_proxy
agentid.register_v2(assistant, user_proxy)

# AutoGen v0.4+ — pass as a tools list
tools = agentid.as_tools()
assistant = AssistantAgent(name="assistant", tools=tools)

# Sign outputs before handing off to other agents
signed = identity.sign({"result": "analysis complete", "data": [1, 2, 3]})
```

---

## CrewAI integration

```python
import os
from crewai import Agent as CrewAgent, Task, Crew
from agentid.integrations.crewai import (
    load_or_create,
    AgentIDFindTool,
    AgentIDVerifyTool,
)

# First run — create identity, save the DID
identity, sign_tool = load_or_create(
    name="research-agent",
    capabilities=["web-search", "summarization"],
    owner="team@company.com",
    registry_url="https://api.agentid-protocol.com",
)
print(f"DID (save this): {identity.did}")

# Subsequent runs — reload
identity, sign_tool = load_or_create(
    did=os.environ["MY_AGENT_DID"],
    name="research-agent",
    capabilities=["web-search"],
    owner="team@company.com",
    registry_url="https://api.agentid-protocol.com",
)

tools = [
    AgentIDFindTool(registry_url="https://api.agentid-protocol.com"),
    AgentIDVerifyTool(registry_url="https://api.agentid-protocol.com"),
    sign_tool,   # lets the agent sign its own outputs
]

researcher = CrewAgent(
    role="Senior Researcher",
    goal="Find trusted agents and verify their outputs",
    backstory="Expert researcher specializing in multi-agent systems",
    tools=tools,
)
```

---

## Registry server

The hosted public registry is at **`https://api.agentid-protocol.com`**.

```bash
# Check it's live
curl https://api.agentid-protocol.com/health

# Resolve any DID
curl https://api.agentid-protocol.com/agents/<did>

# Search by capability (paginated)
curl "https://api.agentid-protocol.com/agents?capability=research&limit=50&offset=0"
```

Or run your own:

```bash
cd registry
pip3 install -r requirements.txt
DATABASE_URL=postgresql://... uvicorn server:app --host 0.0.0.0 --port 8000
```

REST API:

```
POST   /agents                         Register an agent (proof required)
GET    /agents/{did}                   Resolve a DID
GET    /agents?capability=&limit=&offset=  Discover agents (paginated, max 500)
POST   /agents/{did}/verify            Verify a signature → {valid, did, reason}
DELETE /agents/{did}                   Deregister (signed proof required)
GET    /health                         Health check
```

> **Note:** Registration requires a cryptographic `proof` field — an Ed25519 signature proving you own the private key for the DID. The SDK handles this automatically.

---

## Pro features

The hosted registry includes commercial features for teams:

| Feature | Free | Pro | Enterprise |
|---|---|---|---|
| Agents | 100 | 10,000 | Unlimited |
| Audit log exports (CSV/JSON) | — | ✓ | ✓ |
| Analytics dashboard | — | ✓ | ✓ |
| Verified identity badges | — | — | ✓ |

**Dashboard:** [agentid.dev/dashboard](https://agentid.dev/dashboard)

Contact [hello@vikhulus.com](mailto:hello@vikhulus.com) for a Pro or Enterprise API key.

---

## Protocol

AgentID uses:

- **Ed25519** — fast, small, battle-tested signatures
- **W3C DID format** — `did:agentid:<base58-public-key>`
- **JSON canonical form** — deterministic serialization for signing
- **Mandatory proof-of-ownership** — registration requires signing the document with the private key

[Full protocol spec →](spec/protocol.md)

---

## Project structure

```
sdk/python/agentid/
  agent.py              Agent class — create, load, sign, verify, find
  identity.py           DID generation, Ed25519 keypairs
  crypto.py             Sign and verify payloads
  registry.py           Local file-based registry
  http_registry.py      Remote HTTP registry client
  integrations/
    langchain.py        LangChain callback handler + tools

integrations/
  langchain-agentid/    Standalone LangChain package
  autogen-agentid/      Standalone AutoGen package
  crewai-agentid/       Standalone CrewAI package

registry/
  server.py             FastAPI registry server

spec/
  protocol.md           Open protocol specification
```

---

## Roadmap

- [x] Ed25519 identity + DIDs
- [x] Local and remote registry
- [x] LangChain integration
- [x] AutoGen integration
- [x] CrewAI integration
- [x] Hosted public registry
- [x] Pro: audit log exports (CSV/JSON)
- [x] Pro: analytics dashboard
- [x] Enterprise: verified identity badges
- [x] TypeScript SDK
- [ ] Stripe self-serve signup
- [ ] Interaction receipts + reputation layer

---

## Contributing

AgentID is an open protocol. The more frameworks adopt it as the default identity layer, the more useful it becomes for everyone building multi-agent systems.

PRs welcome — especially framework integrations and SDK ports.

```bash
git clone https://github.com/bekisol/agentid
cd agentid/sdk/python
pip3 install -e ".[dev]"
pytest
```

---

## License

MIT
