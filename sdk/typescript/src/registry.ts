/**
 * HTTP registry client — talks to a remote AgentID registry server.
 * Private keys never leave the machine.
 */

import { existsSync, mkdirSync, readFileSync, openSync, writeSync, closeSync, fchmodSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { sign as cryptoSign } from "./crypto.js";

const DEFAULT_KEYS_DIR = join(homedir(), ".agentid", "keys");
const FETCH_TIMEOUT_MS = 10_000; // 10 seconds

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

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wrap fetch with a timeout so a slow registry can't hang the app. */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Validate that a parsed JSON body has the shape of an AgentDocument. */
function assertAgentDocument(data: unknown): AgentDocument {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Invalid registry response: expected an agent document object");
  }
  const d = data as Record<string, unknown>;
  if (typeof d.did !== "string")          throw new Error("Invalid registry response: missing 'did'");
  if (typeof d.name !== "string")         throw new Error("Invalid registry response: missing 'name'");
  if (!Array.isArray(d.capabilities))     throw new Error("Invalid registry response: missing 'capabilities'");
  if (typeof d.owner !== "string")        throw new Error("Invalid registry response: missing 'owner'");
  if (typeof d.public_key !== "string")   throw new Error("Invalid registry response: missing 'public_key'");
  if (typeof d.created_at !== "string")   throw new Error("Invalid registry response: missing 'created_at'");
  if (!d.metadata || typeof d.metadata !== "object") {
    throw new Error("Invalid registry response: missing 'metadata'");
  }
  return d as unknown as AgentDocument;
}

// ── HTTPRegistry ──────────────────────────────────────────────────────────────

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
    // Replace path-unsafe characters, then verify the result stays inside keysDir
    const filename = did.replace(/[^a-zA-Z0-9_-]/g, "_") + ".key";
    const full = resolve(join(this.keysDir, filename));
    const safeDir = resolve(this.keysDir);
    if (!full.startsWith(safeDir + "/") && full !== safeDir) {
      // Should never happen after the replace above, but guard anyway
      throw new Error("Invalid DID: produces unsafe key path");
    }
    return full;
  }

  savePrivateKey(did: string, privateKeyBytes: Uint8Array): void {
    const path = this.keyPath(did);
    // Open with O_CREAT | O_WRONLY | O_TRUNC and mode 0o600 atomically —
    // avoids the TOCTOU race of writeFileSync() then chmodSync()
    const fd = openSync(path, "w", 0o600);
    try {
      writeSync(fd, Buffer.from(privateKeyBytes));
    } finally {
      closeSync(fd);
    }
    // Belt-and-suspenders: verify permissions actually set
    fchmodSync(openSync(path, "r"), 0o600);
  }

  loadPrivateKey(did: string): Uint8Array | null {
    const path = this.keyPath(did);
    if (!existsSync(path)) return null;
    return new Uint8Array(readFileSync(path));
  }

  // ── Remote operations ─────────────────────────────────────────────────────

  async register(document: AgentDocument, privateKeyBytes: Uint8Array): Promise<void> {
    // Whitelist fields explicitly — never spread untrusted objects
    const payload: Record<string, unknown> = {
      did:          document.did,
      name:         document.name,
      capabilities: document.capabilities,
      owner:        document.owner,
      public_key:   document.public_key,
      created_at:   document.created_at,
      metadata:     document.metadata,
    };
    const proof = cryptoSign(privateKeyBytes, payload);

    const res = await fetchWithTimeout(`${this.baseUrl}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, proof }),
    });

    if (res.status === 409) {
      throw new Error(`Agent already registered: ${document.did}`);
    }
    if (!res.ok) {
      // Don't include full response body — it may contain internal server info
      throw new Error(`Registry registration failed with status ${res.status}`);
    }

    this.savePrivateKey(document.did, privateKeyBytes);
  }

  async get(did: string): Promise<AgentDocument | null> {
    const res = await fetchWithTimeout(
      `${this.baseUrl}/agents/${encodeURIComponent(did)}`
    );
    if (res.status === 404) return null;
    if (res.status === 410) {
      // Agent was removed by admin — parse safely
      let reason = "unknown reason";
      let removedAt = "unknown time";
      try {
        const body = await res.json() as { detail?: { reason?: unknown; removed_at?: unknown } };
        if (typeof body?.detail?.reason === "string") reason = body.detail.reason;
        if (typeof body?.detail?.removed_at === "string") removedAt = body.detail.removed_at;
      } catch { /* ignore parse errors */ }
      throw new Error(`Agent was removed by registry admin: ${reason} (at ${removedAt})`);
    }
    if (!res.ok) {
      throw new Error(`Registry lookup failed with status ${res.status}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      throw new Error("Unexpected content-type from registry");
    }
    const data = await res.json();
    return assertAgentDocument(data);
  }

  async search(params: SearchParams = {}): Promise<AgentDocument[]> {
    // Validate search params before sending
    if (params.limit !== undefined && (params.limit < 1 || params.limit > 500)) {
      throw new Error("limit must be between 1 and 500");
    }
    if (params.capability && params.capability.length > 128) {
      throw new Error("capability too long (max 128 chars)");
    }
    if (params.owner && params.owner.length > 256) {
      throw new Error("owner too long (max 256 chars)");
    }
    if (params.name && params.name.length > 256) {
      throw new Error("name too long (max 256 chars)");
    }

    const qs = new URLSearchParams();
    if (params.capability) qs.set("capability", params.capability);
    if (params.owner)      qs.set("owner", params.owner);
    if (params.name)       qs.set("name", params.name);
    if (params.limit)      qs.set("limit", String(params.limit));
    if (params.offset)     qs.set("offset", String(params.offset));

    const res = await fetchWithTimeout(`${this.baseUrl}/agents?${qs}`);
    if (!res.ok) throw new Error(`Registry search failed with status ${res.status}`);

    const data = await res.json();
    if (!Array.isArray(data)) {
      throw new Error("Invalid registry response: expected an array");
    }
    return data.map(assertAgentDocument);
  }

  async deregister(did: string, privateKeyBytes: Uint8Array): Promise<void> {
    const payload = {
      action: "deregister",
      did,
      timestamp: Date.now() / 1000,
    };
    const signature = cryptoSign(privateKeyBytes, payload);

    const res = await fetchWithTimeout(
      `${this.baseUrl}/agents/${encodeURIComponent(did)}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload, signature }),
      }
    );

    if (!res.ok) throw new Error(`Registry deregister failed with status ${res.status}`);
  }

  async update(
    did: string,
    privateKeyBytes: Uint8Array,
    fields: Partial<Pick<AgentDocument, "name" | "owner" | "capabilities" | "metadata">>
  ): Promise<AgentDocument> {
    // Whitelist update fields explicitly — no spread of untrusted objects
    const payload: Record<string, unknown> = {
      action:    "update",
      did,
      timestamp: Date.now() / 1000,
    };
    if (fields.name         !== undefined) payload.name         = fields.name;
    if (fields.owner        !== undefined) payload.owner        = fields.owner;
    if (fields.capabilities !== undefined) payload.capabilities = fields.capabilities;
    if (fields.metadata     !== undefined) payload.metadata     = fields.metadata;

    const signature = cryptoSign(privateKeyBytes, payload);

    const res = await fetchWithTimeout(
      `${this.baseUrl}/agents/${encodeURIComponent(did)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload, signature }),
      }
    );

    if (!res.ok) {
      throw new Error(`Registry update failed with status ${res.status}`);
    }
    const data = await res.json();
    return assertAgentDocument(data);
  }

  async verifySignature(
    did: string,
    payload: Record<string, unknown>,
    signature: string
  ): Promise<boolean> {
    const res = await fetchWithTimeout(
      `${this.baseUrl}/agents/${encodeURIComponent(did)}/verify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload, signature }),
      }
    );
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`Registry verify failed with status ${res.status}`);
    const body = await res.json() as { valid?: unknown };
    return body.valid === true;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetchWithTimeout(`${this.baseUrl}/health`);
      return res.status === 200;
    } catch {
      return false;
    }
  }
}
