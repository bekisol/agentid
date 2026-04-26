/**
 * Agent — the main class for the AgentID TypeScript SDK.
 */

import { randomUUID } from "crypto";
import { sign as cryptoSign, verify as cryptoVerify } from "./crypto.js";
import {
  generateKeypair,
  publicKeyToDid,
  publicKeyToB64,
  b64ToPublicKeyBytes,
  didToPublicKeyBytes,
} from "./identity.js";
import { HTTPRegistry, AgentDocument, SearchParams } from "./registry.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CreateAgentOptions {
  name: string;
  capabilities: string[];
  owner: string;
  metadata?: Record<string, unknown>;
  registryUrl: string;
}

export interface LoadAgentOptions {
  did: string;
  registryUrl: string;
}

export interface SignedMessage {
  payload: Record<string, unknown>;
  signature: string;
}

// ── Agent ─────────────────────────────────────────────────────────────────────

export class Agent {
  readonly document: AgentDocument;
  private readonly _privateKey: Uint8Array | null;
  private readonly _registry: HTTPRegistry;

  private constructor(
    document: AgentDocument,
    registry: HTTPRegistry,
    privateKey: Uint8Array | null = null
  ) {
    this.document = document;
    this._registry = registry;
    this._privateKey = privateKey;
  }

  // ── Properties ──────────────────────────────────────────────────────────────

  get did(): string       { return this.document.did; }
  get name(): string      { return this.document.name; }
  get owner(): string     { return this.document.owner; }
  get capabilities(): string[] { return this.document.capabilities; }
  get metadata(): Record<string, unknown> { return this.document.metadata; }
  get publicKey(): string { return this.document.public_key; }

  // ── Factory: create a new agent ──────────────────────────────────────────────

  static async create(options: CreateAgentOptions): Promise<Agent> {
    const { name, capabilities, owner, metadata = {}, registryUrl } = options;

    // Validate inputs before touching the network — server enforces these too,
    // but fail fast on the client so error messages are clearer
    if (!name || name.length > 256) {
      throw new Error("name must be 1–256 characters");
    }
    if (!owner || !owner.trim() || owner.length > 256) {
      throw new Error("owner must be 1–256 characters");
    }
    if (capabilities.length > 100) {
      throw new Error("too many capabilities (max 100)");
    }
    for (const cap of capabilities) {
      if (!/^[a-zA-Z0-9_-]+$/.test(cap) || cap.length > 128) {
        throw new Error(`invalid capability: '${cap}' (alphanumeric, dash, underscore, max 128 chars)`);
      }
    }
    if (JSON.stringify(metadata).length > 10_000) {
      throw new Error("metadata too large (max 10KB)");
    }

    const { privateKey, publicKey } = generateKeypair();
    const did = publicKeyToDid(publicKey);

    const document: AgentDocument = {
      did,
      name,
      capabilities,
      owner,
      public_key: publicKeyToB64(publicKey),
      created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      metadata,
    };

    const registry = new HTTPRegistry(registryUrl);
    await registry.register(document, privateKey);

    return new Agent(document, registry, privateKey);
  }

  // ── Factory: load an existing agent by DID ───────────────────────────────────

  static async load(options: LoadAgentOptions): Promise<Agent> {
    const { did, registryUrl } = options;
    const registry = new HTTPRegistry(registryUrl);
    const data = await registry.get(did);

    if (!data) throw new Error(`Agent not found: ${did}`);

    // Verify DID is cryptographically bound to the stored public key
    const pubKeyBytes = b64ToPublicKeyBytes(data.public_key);
    const expectedDid = publicKeyToDid(pubKeyBytes);
    if (data.did !== expectedDid) {
      throw new Error(`Registry corruption: DID ${did} does not match stored public key`);
    }

    const privateKey = registry.loadPrivateKey(did);
    return new Agent(data, registry, privateKey);
  }

  // ── Discovery ────────────────────────────────────────────────────────────────

  static async resolve(did: string, registryUrl: string): Promise<AgentDocument | null> {
    const registry = new HTTPRegistry(registryUrl);
    return registry.get(did);
  }

  static async find(
    params: SearchParams & { registryUrl: string }
  ): Promise<AgentDocument[]> {
    const { registryUrl, ...searchParams } = params;
    const registry = new HTTPRegistry(registryUrl);
    return registry.search(searchParams);
  }

  // ── Signing ──────────────────────────────────────────────────────────────────

  sign(payload: Record<string, unknown>): SignedMessage {
    if (!this._privateKey) {
      throw new Error("No private key — agent was loaded read-only");
    }
    const signedPayload = {
      ...payload,
      signer: this.did,
      timestamp: Date.now() / 1000,
      nonce: randomUUID(),
    };
    return {
      payload: signedPayload,
      signature: cryptoSign(this._privateKey, signedPayload),
    };
  }

  verifyMessage(signedMessage: SignedMessage, maxAgeSeconds = 300): boolean {
    const timestamp = signedMessage.payload.timestamp;
    if (typeof timestamp === "number") {
      if (Date.now() / 1000 - timestamp > maxAgeSeconds) return false;
    }
    const pubKeyBytes = b64ToPublicKeyBytes(this.document.public_key);
    return cryptoVerify(pubKeyBytes, signedMessage.payload, signedMessage.signature);
  }

  static async verifyFromDid(
    signedMessage: SignedMessage,
    registryUrl: string,
    maxAgeSeconds = 300
  ): Promise<boolean> {
    const did = signedMessage.payload.signer;
    if (typeof did !== "string") return false;

    const timestamp = signedMessage.payload.timestamp;
    if (typeof timestamp === "number") {
      if (Date.now() / 1000 - timestamp > maxAgeSeconds) return false;
    }

    const registry = new HTTPRegistry(registryUrl);
    const data = await registry.get(did);
    if (!data) return false;

    const pubKeyBytes = b64ToPublicKeyBytes(data.public_key);
    return cryptoVerify(pubKeyBytes, signedMessage.payload, signedMessage.signature);
  }

  // ── Update ───────────────────────────────────────────────────────────────────

  async update(
    fields: Partial<Pick<AgentDocument, "name" | "owner" | "capabilities" | "metadata">>
  ): Promise<Agent> {
    if (!this._privateKey) {
      throw new Error("No private key — agent was loaded read-only");
    }
    const updated = await this._registry.update(this.did, this._privateKey, fields);
    return new Agent(updated, this._registry, this._privateKey);
  }

  // ── Deregister ───────────────────────────────────────────────────────────────

  async deregister(): Promise<void> {
    if (!this._privateKey) {
      throw new Error("No private key — agent was loaded read-only");
    }
    await this._registry.deregister(this.did, this._privateKey);
  }

  // ── Repr ─────────────────────────────────────────────────────────────────────

  toString(): string {
    return `Agent(name=${this.name}, did=${this.did.slice(0, 30)}..., capabilities=${JSON.stringify(this.capabilities)})`;
  }
}
