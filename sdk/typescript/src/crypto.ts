/**
 * Cryptographic primitives for AgentID.
 *
 * Uses @noble/ed25519 v2 (pure JS, async API, works in Node 18+ and browsers).
 * Canonical JSON matches Python: json.dumps(payload, sort_keys=True, separators=(",", ":"))
 */

import * as ed from "@noble/ed25519";

// ── Canonical JSON ────────────────────────────────────────────────────────────
// Keys are sorted recursively at every nesting level to match Python's sort_keys=True.

function canonicalString(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number")
    return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map(canonicalString).join(",") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const pairs = keys.map((k) => JSON.stringify(k) + ":" + canonicalString(obj[k]));
    return "{" + pairs.join(",") + "}";
  }
  return JSON.stringify(value);
}

/**
 * Serialize a payload to canonical JSON bytes.
 * Exported so callers can inspect the exact bytes that get signed.
 */
export function canonical(payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(canonicalString(payload));
}

// ── Base64 helpers ────────────────────────────────────────────────────────────

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

// ── Keypair generation ────────────────────────────────────────────────────────

/**
 * Generate a fresh Ed25519 keypair.
 * Returns raw 32-byte private key and 32-byte public key.
 */
export async function generateKeypair(): Promise<{
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

// ── Sign / Verify ─────────────────────────────────────────────────────────────

/**
 * Sign a payload dict with an Ed25519 private key.
 * Returns a base64-encoded signature string (matches Python SDK output).
 */
export async function sign(
  privateKey: Uint8Array,
  payload: Record<string, unknown>
): Promise<string> {
  const msg = canonical(payload);
  const sig = await ed.sign(msg, privateKey);
  return toBase64(sig);
}

/**
 * Verify an Ed25519 signature against a payload dict.
 * Returns true only if the signature is valid for the given public key.
 */
export async function verify(
  publicKey: Uint8Array,
  payload: Record<string, unknown>,
  signature: string
): Promise<boolean> {
  try {
    const msg = canonical(payload);
    const sig = fromBase64(signature);
    return await ed.verify(sig, msg, publicKey);
  } catch {
    return false;
  }
}
