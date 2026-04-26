/**
 * HTTP registry client — talks to a remote AgentID registry server.
 * Private keys never leave the machine.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { sign as cryptoSign } from "./crypto.js";

const DEFAULT_KEYS_DIR = join(homedir(), ".agentid", "keys");

export interface AgentDocument {
  did: string;
  name: string;
  capabilities: string[];
  owner: string;
  public_key: string;
  created_at: string;
  metadata: Record<string, unknown>;
}

export interface SearchParams {
  capability?: string;
  owner?: string;
  name?: string;
  limit?: number;
  offset?: number;
}

export class HTTPRegistry {
  readonly baseUrl: string;
  readonly keysDir: string;

  constructor(url: string, keysDir?: string) {
    // Enforce HTTPS for remote registries (allow localhost for dev)
    if (
      !url.startsWith("https://") &&
      !url.startsWith("http://localhost") &&
      !url.startsWith("http://127.0.0.1")
    ) {
      throw new Error("Registry URL must use HTTPS (or localhost for dev)");
    }
    this.baseUrl = url.replace(/\/$/, "");
    this.keysDir = keysDir ?? DEFAULT_KEYS_DIR;
    mkdirSync(this.keysDir, { recursive: true });
  }

  // ── Private key storage (always local, never sent to server) ─────────────

  private keyPath(did: string): string {
    return join(this.keysDir, did.replace(/:/g, "_") + ".key");
  }

  savePrivateKey(did: string, privateKeyBytes: Uint8Array): void {
    const path = this.keyPath(did);
    writeFileSync(path, Buffer.from(privateKeyBytes));
    chmodSync(path, 0o600); // owner read/write only
  }

  loadPrivateKey(did: string): Uint8Array | null {
    const path = this.keyPath(did);
    if (!existsSync(path)) return null;
    return new Uint8Array(readFileSync(path));
  }

  // ── Remote operations ─────────────────────────────────────────────────────

  async register(document: AgentDocument, privateKeyBytes: Uint8Array): Promise<void> {
    const payload = { ...document } as Record<string, unknown>;
    const proof = cryptoSign(privateKeyBytes, payload);

    const res = await fetch(`${this.baseUrl}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, proof }),
    });

    if (res.status === 409) {
      throw new Error(`Agent already registered: ${document.did}`);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Registry error ${res.status}: ${body}`);
    }

    this.savePrivateKey(document.did, privateKeyBytes);
  }

  async get(did: string): Promise<AgentDocument | null> {
    const res = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(did)}`);
    if (res.status === 404) return null;
    if (res.status === 410) {
      const body = await res.json() as { detail: { message: string; reason: string; removed_at: string } };
      throw new Error(`Agent removed: ${body.detail.reason} (at ${body.detail.removed_at})`);
    }
    if (!res.ok) {
      throw new Error(`Registry error ${res.status}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      throw new Error(`Unexpected content-type from registry: ${ct}`);
    }
    return res.json() as Promise<AgentDocument>;
  }

  async search(params: SearchParams = {}): Promise<AgentDocument[]> {
    const qs = new URLSearchParams();
    if (params.capability) qs.set("capability", params.capability);
    if (params.owner)      qs.set("owner", params.owner);
    if (params.name)       qs.set("name", params.name);
    if (params.limit)      qs.set("limit", String(params.limit));
    if (params.offset)     qs.set("offset", String(params.offset));

    const res = await fetch(`${this.baseUrl}/agents?${qs}`);
    if (!res.ok) throw new Error(`Registry error ${res.status}`);
    return res.json() as Promise<AgentDocument[]>;
  }

  async deregister(did: string, privateKeyBytes: Uint8Array): Promise<void> {
    const payload = {
      action: "deregister",
      did,
      timestamp: Date.now() / 1000,
    };
    const signature = cryptoSign(privateKeyBytes, payload);

    const res = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(did)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload, signature }),
    });

    if (!res.ok) throw new Error(`Registry error ${res.status}`);
  }

  async update(
    did: string,
    privateKeyBytes: Uint8Array,
    fields: Partial<Pick<AgentDocument, "name" | "owner" | "capabilities" | "metadata">>
  ): Promise<AgentDocument> {
    const payload = {
      action: "update",
      did,
      timestamp: Date.now() / 1000,
      ...fields,
    };
    const signature = cryptoSign(privateKeyBytes, payload as Record<string, unknown>);

    const res = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(did)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload, signature }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Registry error ${res.status}: ${body}`);
    }
    return res.json() as Promise<AgentDocument>;
  }

  async verifySignature(
    did: string,
    payload: Record<string, unknown>,
    signature: string
  ): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(did)}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload, signature }),
    });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`Registry error ${res.status}`);
    const body = await res.json() as { valid: boolean };
    return body.valid;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      return res.status === 200;
    } catch {
      return false;
    }
  }
}
