/**
 * Agent — main class for the AgentID TypeScript SDK.
 *
 * Create agents, sign messages, and verify agent identities.
 * Mirrors the Python SDK's Agent class interface.
 */

import { sign as cryptoSign, verify as cryptoVerify, generateKeypair } from "./crypto.js";
import { getPublicKey } from "@noble/ed25519";
import {
  publicKeyToDid,
  publicKeyToBase64,
  base64ToPublicKey,
  didToPublicKey,
} from "./identity.js";
import { RegistryClient, AgentDocument } from "./registry.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SignedMessage {
  /** The original payload with signer_did, timestamp, and nonce injected. */
  payload: Record<string, unknown>;
  /** Base64-encoded Ed25519 signature of the canonical payload. */
  signature: string;
  /** DID of the agent that produced this message. */
  signer_did: string;
  /** Unix timestamp in milliseconds when the message was signed. */
  timestamp: number;
  /** Random UUID nonce for replay protection. */
  nonce: string;
}

export interface CreateAgentOptions {
  name: string;
  capabilities: string[];
  owner: string;
  metadata?: Record<string, unknown>;
  registry?: RegistryClient;
}

/** Options for building and signing a Capability Contract. */
export interface CapabilityContractOptions {
  /** Lowercase kebab-case capability name, e.g. "web-search". */
  capability: string;
  /** Semver string, e.g. "1.0" or "2.1.0". Defaults to "1.0". */
  version?: string;
  /** Human-readable description of what this capability does. */
  description?: string;
  /** JSON schema describing the input this capability accepts. */
  input_schema?: Record<string, unknown>;
  /** JSON schema describing the output this capability returns. */
  output_schema?: Record<string, unknown>;
  /** SLA commitments: max_latency_seconds, availability_target. */
  sla?: Record<string, unknown>;
  /** Pricing: { model: "free"|"per_call"|"subscription", price_usd? } */
  pricing?: Record<string, unknown>;
  /** Remedies for failures: { on_sla_breach, on_hallucination, ... } */
  remedies?: Record<string, unknown>;
}

/** A signed Capability Contract ready for submission to the registry. */
export interface SignedContract extends Record<string, unknown> {
  did: string;
  capability: string;
  version: string;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  sla: Record<string, unknown>;
  pricing: Record<string, unknown>;
  remedies: Record<string, unknown>;
  signature: string;
  signed_at: string;
}

// ── Agent ─────────────────────────────────────────────────────────────────────

export class Agent {
  readonly did: string;
  readonly name: string;
  readonly capabilities: string[];

  /** Full agent document from the registry. */
  readonly document: AgentDocument;

  private readonly _privateKey: Uint8Array | null;
  private readonly _publicKey: Uint8Array;
  private readonly _registry: RegistryClient | null;

  private constructor(
    document: AgentDocument,
    publicKey: Uint8Array,
    privateKey: Uint8Array | null = null,
    registry: RegistryClient | null = null
  ) {
    this.document = document;
    this.did = document.did;
    this.name = document.name;
    this.capabilities = document.capabilities;
    this._publicKey = publicKey;
    this._privateKey = privateKey;
    this._registry = registry;
  }

  // ── Factory: create a brand-new agent ─────────────────────────────────────

  /**
   * Generate a new Ed25519 keypair, build an agent document, and register it
   * with the registry (if one is supplied).
   *
   * If no registry is provided the agent is created locally — useful for
   * testing and offline scenarios.
   */
  static async create(opts: CreateAgentOptions): Promise<Agent> {
    const { name, capabilities, owner, metadata = {}, registry = null } = opts;

    const { privateKey, publicKey } = await generateKeypair();
    const did = publicKeyToDid(publicKey);

    const document: AgentDocument = {
      did,
      name,
      capabilities,
      owner,
      public_key: publicKeyToBase64(publicKey),
      created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      metadata,
    };

    if (registry) {
      // Sign the canonical document to prove ownership of the private key.
      const docPayload: Record<string, unknown> = {
        did:          document.did,
        name:         document.name,
        capabilities: document.capabilities,
        owner:        document.owner,
        public_key:   document.public_key,
        created_at:   document.created_at,
        metadata:     document.metadata,
      };
      const proof = await cryptoSign(privateKey, docPayload);
      await registry.register(document, proof);
    }

    return new Agent(document, publicKey, privateKey, registry);
  }

  // ── Factory: restore from a saved private key ─────────────────────────────

  /**
   * Reconstruct an Agent from a previously exported private key.
   *
   * If a registry is provided the agent's public document is fetched and
   * validated against the stored key. Without a registry the agent can still
   * sign messages — it just won't be able to fetch its own document.
   */
  static async fromPrivateKey(
    privateKey: Uint8Array,
    registry?: RegistryClient
  ): Promise<Agent> {
    const publicKey = await getPublicKey(privateKey);
    const did = publicKeyToDid(publicKey);

    let document: AgentDocument;

    if (registry) {
      document = await registry.resolve(did);
      // Sanity-check: the registry's stored public key must match ours.
      const storedKey = base64ToPublicKey(document.public_key);
      if (!uint8ArrayEqual(storedKey, publicKey)) {
        throw new Error(
          "Registry corruption: stored public key does not match private key"
        );
      }
    } else {
      // Build a minimal placeholder document (offline mode).
      document = {
        did,
        name: did,
        capabilities: [],
        owner: "",
        public_key: publicKeyToBase64(publicKey),
        created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        metadata: {},
      };
    }

    return new Agent(document, publicKey, privateKey, registry ?? null);
  }

  // ── Signing ───────────────────────────────────────────────────────────────

  /**
   * Sign an arbitrary payload.
   *
   * Injects `signer_did`, `timestamp` (ms), and `nonce` (UUID) into the
   * payload before signing — providing replay protection out of the box.
   */
  async sign(payload: Record<string, unknown>): Promise<SignedMessage> {
    if (!this._privateKey) {
      throw new Error("No private key — agent was loaded read-only");
    }

    const timestamp = Date.now();
    const nonce = crypto.randomUUID();

    const signedPayload: Record<string, unknown> = {
      ...payload,
      signer_did: this.did,
      timestamp,
      nonce,
    };

    const signature = await cryptoSign(this._privateKey, signedPayload);

    return { payload: signedPayload, signature, signer_did: this.did, timestamp, nonce };
  }

  // ── Local verification (you already have the signer's public key) ─────────

  /**
   * Verify a signed message using this agent's own public key.
   *
   * Use this when you already have the signer's Agent instance locally.
   * For cross-agent verification, use `Agent.verifyFromRegistry()`.
   */
  async verifyLocal(msg: SignedMessage): Promise<boolean> {
    return cryptoVerify(this._publicKey, msg.payload, msg.signature);
  }

  // ── Registry-based verification (look up the signer's DID) ───────────────

  /**
   * Verify a signed message by resolving the signer's DID from the registry.
   *
   * The registry is queried for the signer's public key, which is then used
   * to verify the signature locally. The private key never leaves the signer.
   */
  static async verifyFromRegistry(
    msg: SignedMessage,
    registry: RegistryClient
  ): Promise<boolean> {
    try {
      const doc = await registry.resolve(msg.signer_did);
      const publicKey = base64ToPublicKey(doc.public_key);

      // Validate that the DID is cryptographically bound to the stored key.
      const expectedDid = publicKeyToDid(publicKey);
      if (doc.did !== expectedDid) {
        return false; // Registry corruption
      }

      return cryptoVerify(publicKey, msg.payload, msg.signature);
    } catch {
      return false;
    }
  }

  // ── Key export ────────────────────────────────────────────────────────────

  /**
   * Export the raw private key bytes so the caller can persist them securely.
   * Store these somewhere safe — they are the only way to recover the agent.
   */
  exportPrivateKey(): Uint8Array {
    if (!this._privateKey) {
      throw new Error("No private key available (agent loaded read-only)");
    }
    // Return a copy to prevent external mutation.
    return new Uint8Array(this._privateKey);
  }

  // ── Capability Contracts ─────────────────────────────────────────────────

  /**
   * Build and cryptographically sign a Capability Contract.
   *
   * The signature covers the canonical contract body (JSON with sorted keys,
   * no spaces) using this agent's Ed25519 private key — matches server-side
   * verification in capability_contracts._verify_contract_signature().
   *
   * @example
   * const contract = await agent.signCapabilityContract({
   *   capability: 'web-search',
   *   sla: { max_latency_seconds: 5, availability_target: 0.99 },
   *   pricing: { model: 'per_call', price_usd: 0.001 },
   *   remedies: { on_sla_breach: 'refund' },
   * });
   */
  async signCapabilityContract(opts: CapabilityContractOptions): Promise<SignedContract> {
    if (!this._privateKey) {
      throw new Error("No private key — agent was loaded read-only");
    }
    const body: Record<string, unknown> = {
      did:           this.did,
      capability:    opts.capability,
      version:       opts.version ?? "1.0",
      description:   opts.description ?? "",
      input_schema:  opts.input_schema ?? {},
      output_schema: opts.output_schema ?? {},
      sla:           opts.sla ?? {},
      pricing:       opts.pricing ?? { model: "free" },
      remedies:      opts.remedies ?? {},
    };
    const signature = await cryptoSign(this._privateKey, body);
    return {
      ...body,
      signature,
      signed_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    } as SignedContract;
  }

  /**
   * Sign and publish a Capability Contract to the registry in one call.
   *
   * Requires the agent to have been created with a registry.
   *
   * @example
   * const result = await agent.publishCapabilityContract({
   *   capability: 'web-search',
   *   sla: { max_latency_seconds: 5, availability_target: 0.99 },
   *   pricing: { model: 'per_call', price_usd: 0.001 },
   * });
   * console.log(result.contract.id);
   */
  async publishCapabilityContract(opts: CapabilityContractOptions): Promise<Record<string, unknown>> {
    if (!this._registry) {
      throw new Error(
        "publishCapabilityContract() requires a registry. " +
        "Pass registry when creating the agent."
      );
    }
    const contract = await this.signCapabilityContract(opts);
    return this._registry.publishCapabilityContract(this.did, contract);
  }

  // ── Repr ──────────────────────────────────────────────────────────────────

  toString(): string {
    return `Agent(name=${this.name}, did=${this.did.slice(0, 30)}..., capabilities=${JSON.stringify(this.capabilities)})`;
  }
}

// ── Convenience factory ───────────────────────────────────────────────────────

/**
 * Top-level convenience function — equivalent to `Agent.create(opts)`.
 *
 * @example
 * import { createAgent } from '@agentid/sdk';
 * const agent = await createAgent({ name: 'my-bot', capabilities: ['search'], owner: 'me@example.com' });
 */
export async function createAgent(opts: CreateAgentOptions): Promise<Agent> {
  return Agent.create(opts);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Constant-time byte array comparison — prevents timing side-channels. */
function uint8ArrayEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
