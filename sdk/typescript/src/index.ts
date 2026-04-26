/**
 * AgentID Protocol — TypeScript SDK
 *
 * Identity, discovery, and trust for AI agents.
 *
 * Quick start:
 *   import { Agent } from 'agentid-protocol'
 *
 *   const agent = await Agent.create({
 *     name: 'my-agent',
 *     capabilities: ['web-search', 'summarization'],
 *     owner: 'team@company.com',
 *     registryUrl: 'https://agentid-commercial-features-production.up.railway.app',
 *   })
 *
 *   console.log(agent.did)
 *
 *   const signed = agent.sign({ result: 'task complete' })
 *   const valid = await Agent.verifyFromDid(signed, registryUrl)
 */

export { Agent } from "./agent.js";
export type { CreateAgentOptions, LoadAgentOptions, SignedMessage } from "./agent.js";

export { HTTPRegistry } from "./registry.js";
export type { AgentDocument, SearchParams } from "./registry.js";

export {
  generateKeypair,
  publicKeyToDid,
  didToPublicKeyBytes,
  publicKeyToB64,
  b64ToPublicKeyBytes,
  DID_PREFIX,
} from "./identity.js";
export type { Keypair } from "./identity.js";

export { sign, verify, toBase64, fromBase64 } from "./crypto.js";
