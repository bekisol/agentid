# @agentid/sdk

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
npm install @agentid/sdk
```

---

## Quick start

```typescript
import { createAgent, Agent } from '@agentid/sdk';

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
import { createAgent, Agent, RegistryClient } from '@agentid/sdk';

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
import { generateKeypair, sign, verify, publicKeyToDid, didToPublicKey } from '@agentid/sdk';

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

## License

MIT
