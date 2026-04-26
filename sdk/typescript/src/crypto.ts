/**
 * Cryptographic primitives for AgentID.
 * Ed25519 signing and verification — matches the Python SDK exactly.
 */

import { ed25519 } from "@noble/curves/ed25519";

// ── Canonical JSON ────────────────────────────────────────────────────────────
// Matches Python: json.dumps(payload, sort_keys=True, separators=(",", ":"))
// Keys are sorted recursively at every nesting level.

function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number")
    return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map(canonical).join(",") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const pairs = keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k]));
    return "{" + pairs.join(",") + "}";
  }
  return JSON.stringify(value);
}

function canonicalBytes(payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(canonical(payload));
}

// ── Base64 helpers ────────────────────────────────────────────────────────────

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

// ── Sign / Verify ─────────────────────────────────────────────────────────────

/**
 * Sign a payload with an Ed25519 private key.
 * Returns the signature as a base64 string.
 */
export function sign(
  privateKeyBytes: Uint8Array,
  payload: Record<string, unknown>
): string {
  const msg = canonicalBytes(payload);
  const sig = ed25519.sign(msg, privateKeyBytes);
  return toBase64(sig);
}

/**
 * Verify an Ed25519 signature against a payload.
 * signature is the base64 string returned by sign().
 */
export function verify(
  publicKeyBytes: Uint8Array,
  payload: Record<string, unknown>,
  signature: string
): boolean {
  try {
    const msg = canonicalBytes(payload);
    const sig = fromBase64(signature);
    return ed25519.verify(sig, msg, publicKeyBytes);
  } catch {
    return false;
  }
}
