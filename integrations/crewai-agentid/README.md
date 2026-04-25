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

```bash
pip install agentid-protocol
```

For the LangChain integration:

```bash
pip install agentid-protocol langchain-agentid
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

```python
agent = Agent.create(
    name="my-agent",
    capabilities=["search"],
    owner="you@company.com",
    registry_url="http://your-registry.com",
)

agents = Agent.find(capability="search", registry_url="http://your-registry.com")
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

### What agents can do with AgentID tools

```
agentid_find("web-search")     → lists all registered agents with web-search capability
agentid_verify(<signed_msg>)   → verifies a message came from the agent it claims
agentid_sign(<payload>)        → signs output for downstream verification
```

---

## Registry server

Run a shared registry so agents across machines can find each other:

```bash
cd registry
pip install -r requirements.txt
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

registry/
  server.py             FastAPI registry server

spec/
  protocol.md           Open protocol specification

examples/
  quickstart.py         Basic usage
  langchain_example.py  LangChain integration demo
```

---

## Roadmap

- [x] Ed25519 identity + DIDs
- [x] Local and remote registry
- [x] LangChain integration
- [ ] TypeScript SDK
- [ ] AutoGen integration
- [ ] CrewAI integration
- [ ] Interaction receipts + reputation layer
- [ ] Hosted public registry

---

## Contributing

AgentID is an open protocol. The more frameworks adopt it as the default identity layer, the more useful it becomes for everyone building multi-agent systems.

PRs welcome — especially framework integrations and SDK ports.

```bash
git clone https://github.com/agentid/agentid
cd agentid/sdk/python
pip install -e ".[dev]"
pytest
```

---

## License

MIT
