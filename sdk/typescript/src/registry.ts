/**
 * HTTP registry client for the AgentID protocol.
 *
 * Uses the native fetch API (Node 18+ / browser).
 * Private keys are never sent to the registry server.
 */

const DEFAULT_BASE_URL = "https://api.agentid-protocol.com";
const FETCH_TIMEOUT_MS = 10_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentDocument {
  did: string;
  name: string;
  capabilities: string[];
  owner: string;
  public_key: string;      // base64-encoded Ed25519 public key
  created_at: string;      // ISO 8601
  metadata: Record<string, unknown>;
}

export interface FindOptions {
  capability?: string;
  owner?: string;
  name?: string;
  limit?: number;
  offset?: number;
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wrap fetch with a timeout so a slow registry can't hang the app. */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
  if (typeof d.did !== "string")
    throw new Error("Invalid registry response: missing 'did'");
  if (typeof d.name !== "string")
    throw new Error("Invalid registry response: missing 'name'");
  if (!Array.isArray(d.capabilities))
    throw new Error("Invalid registry response: missing 'capabilities'");
  if (typeof d.owner !== "string")
    throw new Error("Invalid registry response: missing 'owner'");
  if (typeof d.public_key !== "string")
    throw new Error("Invalid registry response: missing 'public_key'");
  if (typeof d.created_at !== "string")
    throw new Error("Invalid registry response: missing 'created_at'");
  if (!d.metadata || typeof d.metadata !== "object") {
    throw new Error("Invalid registry response: missing 'metadata'");
  }
  return d as unknown as AgentDocument;
}

// ── RegistryClient ────────────────────────────────────────────────────────────

/**
 * HTTP client for the AgentID registry API.
 *
 * @example
 * const registry = new RegistryClient('https://api.agentid-protocol.com', apiKey);
 * const doc = await registry.resolve('did:agentid:...');
 */
export class RegistryClient {
  readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(
    baseUrl: string = DEFAULT_BASE_URL,
    apiKey?: string
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["x-api-key"] = this.apiKey;
    return h;
  }

  private async request(
    path: string,
    options: RequestInit = {}
  ): Promise<Response> {
    return fetchWithTimeout(`${this.baseUrl}${path}`, {
      ...options,
      headers: { ...this.headers, ...(options.headers as Record<string, string> ?? {}) },
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Register a new agent in the registry.
   * The proof is a base64 signature of the canonical document produced by the agent's private key.
   */
  async register(doc: AgentDocument, proof: string): Promise<AgentDocument> {
    const res = await this.request("/agents", {
      method: "POST",
      body: JSON.stringify({ ...doc, proof }),
    });

    if (res.status === 409) {
      throw new Error(`Agent already registered: ${doc.did}`);
    }
    if (!res.ok) {
      throw new Error(`Registry registration failed with status ${res.status}`);
    }

    const data = await res.json();
    return assertAgentDocument(data);
  }

  /**
   * Resolve a DID to its agent document.
   * Throws if the agent does not exist.
   */
  async resolve(did: string): Promise<AgentDocument> {
    const res = await this.request(`/agents/${encodeURIComponent(did)}`);

    if (res.status === 404) {
      throw new Error(`Agent not found: ${did}`);
    }
    if (res.status === 410) {
      let reason = "unknown reason";
      try {
        const body = await res.json() as { detail?: { reason?: unknown } };
        if (typeof body?.detail?.reason === "string") reason = body.detail.reason;
      } catch { /* ignore */ }
      throw new Error(`Agent was removed by registry admin: ${reason}`);
    }
    if (!res.ok) {
      throw new Error(`Registry lookup failed with status ${res.status}`);
    }

    const data = await res.json();
    return assertAgentDocument(data);
  }

  /**
   * Search for agents by capability, owner, or name.
   * Returns all matching agent documents.
   */
  async find(opts: FindOptions = {}): Promise<AgentDocument[]> {
    if (opts.limit !== undefined && (opts.limit < 1 || opts.limit > 500)) {
      throw new Error("limit must be between 1 and 500");
    }

    const qs = new URLSearchParams();
    if (opts.capability) qs.set("capability", opts.capability);
    if (opts.owner)      qs.set("owner", opts.owner);
    if (opts.name)       qs.set("name", opts.name);
    if (opts.limit)      qs.set("limit", String(opts.limit));
    if (opts.offset)     qs.set("offset", String(opts.offset));

    const query = qs.toString();
    const res = await this.request(`/agents${query ? "?" + query : ""}`);

    if (!res.ok) {
      throw new Error(`Registry search failed with status ${res.status}`);
    }

    const data = await res.json();
    if (!Array.isArray(data)) {
      throw new Error("Invalid registry response: expected an array");
    }
    return data.map(assertAgentDocument);
  }

  /**
   * Ask the registry server to verify a signed payload from a given DID.
   * The registry resolves the DID's public key and checks the signature.
   */
  async verify(
    did: string,
    payload: Record<string, unknown>,
    signature: string
  ): Promise<VerifyResult> {
    const res = await this.request(
      `/agents/${encodeURIComponent(did)}/verify`,
      {
        method: "POST",
        body: JSON.stringify({ payload, signature }),
      }
    );

    if (res.status === 404) {
      return { valid: false, reason: `Agent not found: ${did}` };
    }
    if (!res.ok) {
      throw new Error(`Registry verify failed with status ${res.status}`);
    }

    const body = await res.json() as { valid?: unknown; reason?: unknown };
    return {
      valid: body.valid === true,
      reason: typeof body.reason === "string" ? body.reason : undefined,
    };
  }

  /**
   * Check whether the registry server is reachable.
   * Returns true if the health endpoint responds with 200.
   */
  async ping(): Promise<boolean> {
    try {
      const res = await this.request("/health");
      return res.status === 200;
    } catch {
      return false;
    }
  }
}
