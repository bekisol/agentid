/**
 * @agentid/sdk — Identity, discovery, and trust for AI agents.
 *
 * Quick start:
 *
 *   import { createAgent } from '@vikhulus/agentid-protocol';
 *
 *   const agent = await createAgent({
 *     name: 'my-bot',
 *     capabilities: ['summarization', 'web-search'],
 *     owner: 'team@example.com',
 *   });
 *
 *   console.log(agent.did);
 *   // did:agentid:3mFxR8...
 *
 *   const msg = await agent.sign({ task: 'fetch-data', url: 'https://example.com' });
 *   // msg.signature, msg.signer_did, msg.timestamp, msg.nonce
 */

// ── Agent ─────────────────────────────────────────────────────────────────────
export { Agent, createAgent } from "./agent.js";
export type { SignedMessage, CreateAgentOptions, CapabilityContractOptions, SignedContract } from "./agent.js";

// ── Registry ──────────────────────────────────────────────────────────────────
export { RegistryClient } from "./registry.js";
export type { AgentDocument, FindOptions, VerifyResult } from "./registry.js";

// ── Identity ──────────────────────────────────────────────────────────────────
export {
  generateKeypair,
  publicKeyToDid,
  didToPublicKey,
  publicKeyToBase64,
  base64ToPublicKey,
  DID_PREFIX,
  // Legacy aliases for backward compatibility
  publicKeyToB64,
  b64ToPublicKeyBytes,
  didToPublicKeyBytes,
} from "./identity.js";
export type { Keypair } from "./identity.js";

// ── Crypto ────────────────────────────────────────────────────────────────────
export { canonical, sign, verify, toBase64, fromBase64 } from "./crypto.js";
