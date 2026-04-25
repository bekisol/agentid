# AgentID

**Identity, discovery, and trust for AI agents.**

The internet was built for humans. AI agents have no standard way to identify themselves, find each other, or verify that messages are genuine. AgentID is the missing protocol layer.

```python
from agentid import Agent

# Every agent gets a cryptographic identity
agent = Agent.create(
    name="research-agent",
    capabilities=["web-search", "summarization"],
    owner="team@company.com",
)
print(agent.did)
# did:agentid:7sP3V2mNkQxRtYbLcDfHgJwAeUiMoZnXvBqKpTsWyE

# Find agents by what they can do
results = Agent.find(capability="web-search")

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

A registry stores agent documents and makes them discoverable. Run your own or use a shared hosted registry.

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
REGISTRY_URL = "https://agentid-production.up.railway.app"

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

Give any LangChain agent a verifiable identity in 3 lines:

```python
from agentid.integrations.langchain import (
    AgentIDCallbackHandler,
    AgentIDFindTool,
    AgentIDVerifyTool,
)

# 1. Create identity
identity = AgentIDCallbackHandler(
    name="research-agent",
    capabilities=["web-search", "summarization"],
    owner="team@company.com",
)
print(f"Agent DID: {identity.did}")

# 2. Add discovery tools
tools = [
    AgentIDFindTool(),       # lets the agent find other agents by capability
    AgentIDVerifyTool(),     # lets the agent verify messages from other agents
    ...your_other_tools,
]

# 3. Wire up
executor = AgentExecutor(agent=agent, tools=tools, callbacks=[identity])
```

Every output from this executor is automatically signed. Verify it downstream:

```python
from agentid.integrations.langchain import verify_langchain_output

result = executor.invoke({"input": "Research the latest AI papers"})
verify_langchain_output(result)  # → True
```

---

## AutoGen integration

```python
from autogen_agentid import create_agentid_agent

agent = create_agentid_agent(
    name="research-bot",
    capabilities=["research", "summarization"],
    owner="team@company.com",
    system_message="You are a research assistant.",
)
print(agent.agentid_did)  # did:agentid:...
```

Every message sent by this agent is automatically signed. Recipients can verify using the DID.

---

## CrewAI integration

```python
from crewai_agentid import create_agentid_crew_agent, AgentIDObserver

agent = create_agentid_crew_agent(
    role="Senior Researcher",
    goal="Research AI topics",
    backstory="Expert researcher with 10 years experience",
    capabilities=["research", "summarization"],
    owner="team@company.com",
)
print(agent.agentid_did)  # did:agentid:...

# Sign task outputs
observer = AgentIDObserver(signing_agent=agent)
signed_result = observer.sign_task_result("Summary: AI is advancing rapidly.")
```

---

## Registry server

A public registry is hosted at **`https://agentid-production.up.railway.app`**.

```bash
# Check it's live
curl https://agentid-production.up.railway.app/health

# Resolve any DID
curl https://agentid-production.up.railway.app/agents/<did>
```

Or run your own:

```bash
cd registry
pip3 install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8000
```

REST API:

```
POST   /agents              Register an agent
GET    /agents/{did}        Resolve a DID
GET    /agents?capability=  Discover agents by capability
POST   /agents/{did}/verify Verify a signature
DELETE /agents/{did}        Deregister
GET    /health              Health check
```

---

## Protocol

AgentID uses:

- **Ed25519** — fast, small, battle-tested signatures
- **W3C DID format** — `did:agentid:<base58-public-key>`
- **JSON canonical form** — deterministic serialization for signing

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
- [ ] TypeScript SDK
- [ ] Interaction receipts + reputation layer
- [ ] Hosted public registry

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
