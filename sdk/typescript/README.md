# @vikhulus/agentid-protocol

**Identity, discovery, and trust for AI agents — TypeScript SDK**

Give every AI agent a cryptographic identity, let agents discover each other, and verify messages end-to-end without a central authority.

- Ed25519 key pairs — one per agent, generated locally
- DIDs (`did:agentid:<base58-public-key>`) — portable, self-describing identifiers
- Signed messages with nonce + timestamp — built-in replay protection
- HTTP registry client — optional; agents work fully offline too
- Pure JavaScript (`@noble/ed25519`) — Node 18+ and modern browsers

---

## Install

```bash
npm install @vikhulus/agentid-protocol
```

---

## Quick start

```typescript
import { createAgent, Agent } from '@vikhulus/agentid-protocol';

// 1. Create an agent (no registry = fully local)
const agent = await createAgent({
  name: 'my-bot',
  capabilities: ['summarization', 'web-search'],
  owner: 'team@example.com',
});

console.log(agent.did);
// did:agentid:3mFxR8kzWpTqNvYjLdCeAb...

// 2. Sign a message
const msg = await agent.sign({ task: 'fetch', url: 'https://example.com' });
// msg = { payload: {..., signer_did, timestamp, nonce}, signature, signer_did, timestamp, nonce }

// 3. Verify locally (you have the signer's Agent instance)
const agentCopy = await Agent.fromPrivateKey(agent.exportPrivateKey());
const valid = await agentCopy.verifyLocal(msg);
console.log(valid); // true
```

---

## Agent-to-agent authentication

```typescript
import { createAgent, Agent, RegistryClient } from '@vikhulus/agentid-protocol';

const registry = new RegistryClient('https://api.agentid-protocol.com', process.env.AGENTID_API_KEY);

// Agent A: data collector
const agentA = await createAgent({
  name: 'collector',
  capabilities: ['scraping'],
  owner: 'ops@example.com',
  registry,
});

// Agent B: analyst (separate process, loaded from saved key)
const agentB = await createAgent({
  name: 'analyst',
  capabilities: ['reasoning'],
  owner: 'ops@example.com',
  registry,
});

// A signs a task assignment
const task = await agentA.sign({ action: 'analyse', dataset: 'q1-sales.csv' });

// B verifies A's identity via the registry (no prior knowledge of A's key)
const trusted = await Agent.verifyFromRegistry(task, registry);
console.log(trusted); // true — A's public key was fetched and verified

// Tamper detection — modify the payload, signature fails
const tampered = { ...task, payload: { ...task.payload, dataset: 'backdoor.csv' } };
console.log(await Agent.verifyFromRegistry(tampered, registry)); // false
```

---

## API reference

### `createAgent(opts)` / `Agent.create(opts)`

| Option         | Type                        | Required | Description                              |
|----------------|-----------------------------|----------|------------------------------------------|
| `name`         | `string`                    | Yes      | Human-readable name                      |
| `capabilities` | `string[]`                  | Yes      | Tags describing what this agent can do   |
| `owner`        | `string`                    | Yes      | Email, team ID, or owner identifier      |
| `metadata`     | `Record<string, unknown>`   | No       | Arbitrary key/value pairs                |
| `registry`     | `RegistryClient`            | No       | If provided, agent is registered remotely|

Returns `Promise<Agent>`.

---

### `Agent`

| Member                                        | Description                                               |
|-----------------------------------------------|-----------------------------------------------------------|
| `.did`                                        | `did:agentid:<base58-public-key>`                         |
| `.name`                                       | Agent name                                                |
| `.capabilities`                               | Capability tags                                           |
| `.sign(payload)`                              | Sign a payload — returns `SignedMessage`                  |
| `.verifyLocal(msg)`                           | Verify a message using this agent's own public key        |
| `Agent.fromPrivateKey(key, registry?)`        | Restore agent from saved private key bytes                |
| `Agent.verifyFromRegistry(msg, registry)`     | Verify by fetching signer's public key from registry      |
| `.exportPrivateKey()`                         | Export raw 32-byte private key for secure storage         |

---

### `SignedMessage`

```typescript
interface SignedMessage {
  payload:    Record<string, unknown>; // original data + signer_did, timestamp, nonce
  signature:  string;                  // base64 Ed25519 signature
  signer_did: string;                  // DID of signing agent
  timestamp:  number;                  // ms since epoch
  nonce:      string;                  // UUID for replay protection
}
```

---

### `RegistryClient`

```typescript
const registry = new RegistryClient(baseUrl?, apiKey?);
```

| Method                                  | Description                                         |
|-----------------------------------------|-----------------------------------------------------|
| `register(doc, proof)`                  | Register an agent document                          |
| `resolve(did)`                          | Fetch an agent document by DID                      |
| `find({ capability?, owner?, name?, limit? })` | Search for agents                          |
| `verify(did, payload, signature)`       | Server-side signature verification                  |
| `ping()`                                | Health check — returns `boolean`                    |

---

### Crypto utilities

```typescript
import { generateKeypair, sign, verify, publicKeyToDid, didToPublicKey } from '@vikhulus/agentid-protocol';

const { privateKey, publicKey } = await generateKeypair();
const did = publicKeyToDid(publicKey);
const sig = await sign(privateKey, { hello: 'world' });
const ok  = await verify(publicKey, { hello: 'world' }, sig);
```

---

## Key persistence

```typescript
// Export the private key once after creating the agent
const rawKey = agent.exportPrivateKey(); // Uint8Array (32 bytes)
// Store it securely (env variable, secret manager, encrypted file, etc.)

// Later — restore the agent
const agent = await Agent.fromPrivateKey(rawKey, registry);
```

> The private key never leaves your machine. The registry only stores the public key.

---

## Framework integrations

### LangChain.js

Give any LangChain.js agent a verifiable identity and agent-discovery tools using the core SDK:

```typescript
import { createAgent, Agent, RegistryClient } from '@vikhulus/agentid-protocol';
import { DynamicTool } from '@langchain/core/tools';
import { AgentExecutor } from 'langchain/agents';

const REGISTRY = 'https://api.agentid-protocol.com';
const registry = new RegistryClient(REGISTRY, process.env.AGENTID_API_KEY);

// Create a persistent identity (store rawKey in a secret manager)
const identity = await createAgent({
  name: 'research-agent',
  capabilities: ['web-search', 'summarization'],
  owner: 'team@company.com',
  registry,
});
console.log('DID:', identity.did);

// Subsequent starts — reload from saved key
// const identity = await Agent.fromPrivateKey(savedKey, registry);

// Discovery tool — lets the agent find other agents by capability
const findAgentTool = new DynamicTool({
  name: 'find_agent',
  description: 'Find AI agents registered in the network by capability. Input: a capability string.',
  func: async (capability: string) => {
    const agents = await registry.find({ capability });
    return JSON.stringify(agents.map(a => ({ did: a.did, name: a.name, capabilities: a.capabilities })));
  },
});

// Verify tool — lets the agent verify a signed message from another agent
const verifyTool = new DynamicTool({
  name: 'verify_agent_message',
  description: 'Verify a signed message from another agent. Input: JSON string with payload and signature.',
  func: async (input: string) => {
    const msg = JSON.parse(input);
    const valid = await Agent.verifyFromRegistry(msg, registry);
    return JSON.stringify({ valid, signer: msg.signer_did });
  },
});

const executor = AgentExecutor.fromAgentAndTools({
  agent,
  tools: [findAgentTool, verifyTool, /* ...your other tools */],
});

// Sign outputs before sending to other agents
const result = await executor.invoke({ input: 'Research the latest AI papers' });
const signed = await identity.sign({ output: result.output });
// signed.signature — Ed25519 signature any downstream agent can verify
```

---

### Vercel AI SDK

```typescript
import { createAgent, Agent, RegistryClient } from '@vikhulus/agentid-protocol';
import { tool } from 'ai';
import { z } from 'zod';

const registry = new RegistryClient('https://api.agentid-protocol.com');

const identity = await createAgent({
  name: 'vercel-agent',
  capabilities: ['reasoning', 'code-generation'],
  owner: 'team@company.com',
  registry,
});

// Agent-discovery tool for use with generateText / streamText
const findAgentTool = tool({
  description: 'Find AI agents by capability',
  parameters: z.object({ capability: z.string() }),
  execute: async ({ capability }) => {
    return registry.find({ capability });
  },
});

// After generating a response, sign it
const response = await generateText({ model, prompt, tools: { findAgent: findAgentTool } });
const signed = await identity.sign({ output: response.text });
```

---

### AutoGen (Python → TypeScript handoff)

The TypeScript SDK is designed to interoperate with AutoGen Python agents. An AutoGen agent signs its output; a TypeScript service verifies it:

```typescript
import { Agent, RegistryClient } from '@vikhulus/agentid-protocol';

const registry = new RegistryClient('https://api.agentid-protocol.com');

// Receive a signed message from a Python AutoGen agent
const incomingMessage = JSON.parse(req.body);  // { payload, signature, signer_did, ... }

const trusted = await Agent.verifyFromRegistry(incomingMessage, registry);
if (!trusted) {
  throw new Error(`Rejected: unverified message from ${incomingMessage.signer_did}`);
}

console.log('Verified agent:', incomingMessage.signer_did);
```

---

## License

MIT
