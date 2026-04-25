# AgentID Protocol Specification v0.1

## Overview

AgentID is an open protocol for AI agent identity, discovery, and trust.
It gives every agent a verifiable identity, a way to declare capabilities,
and a cryptographic basis for trustless interaction.

## Core Concepts

### Agent Identity

Every agent has a **DID (Decentralized Identifier)**:

```
did:agentid:<base58-encoded-ed25519-public-key>
```

Example:
```
did:agentid:7sP3V2mNkQxRtYbLcDfHgJwAeUiMoZnXvBqKpTsWyE
```

The DID is derived from the agent's public key — no central authority issues it.
Any agent can generate one offline, instantly.

### Agent Document

Every agent publishes a document describing itself:

```json
{
  "did": "did:agentid:7sP3V2mNkQxRtYbLcDfHgJwAeUiMoZnXvBqKpTsWyE",
  "name": "travel-booker",
  "capabilities": ["flight-search", "hotel-booking", "itinerary-planning"],
  "owner": "user@company.com",
  "public_key": "<base64-encoded-ed25519-public-key>",
  "created_at": 1714000000.0,
  "metadata": {}
}
```

### Capabilities

Capabilities are string identifiers declared by the agent. Format: `kebab-case`.

Examples: `web-search`, `code-review`, `contract-analysis`, `image-generation`

### Signed Messages

Any agent can sign a payload to prove it authored it:

```json
{
  "payload": {
    "task": "book flight SFO to NYC",
    "signer": "did:agentid:...",
    "timestamp": 1714000000.0,
    "nonce": "uuid-v4"
  },
  "signature": "<base64-encoded-ed25519-signature>"
}
```

Verification: reconstruct the payload, verify the signature against the
public key embedded in the signer's DID.

## Cryptography

- **Key type:** Ed25519
- **Signing:** `sign(json.dumps(payload, sort_keys=True).encode())`
- **Encoding:** Public keys and signatures are base58/base64 encoded
- **DID:** `did:agentid:` + base58(raw public key bytes)

## Registry

A registry stores and indexes agent documents. It exposes:

```
POST   /agents              Register a new agent
GET    /agents/{did}        Resolve a DID to an agent document
GET    /agents?capability=  Discover agents by capability
DELETE /agents/{did}        Deregister an agent (owner only)
```

Registries are **federated** — anyone can run one. The protocol does not
require a single central registry.

## Interaction Receipts (v0.2)

When Agent A delegates work to Agent B, both parties sign a receipt:

```json
{
  "receipt_id": "uuid",
  "hirer": "did:agentid:...",
  "worker": "did:agentid:...",
  "task_hash": "sha256(task_description)",
  "outcome": "success|failure",
  "hirer_signature": "...",
  "worker_signature": "...",
  "timestamp": 1714000000.0
}
```

Receipts are the foundation of the reputation layer.
