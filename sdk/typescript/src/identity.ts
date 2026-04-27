/**
 * DID and keypair utilities for AgentID.
 *
 * DID format: did:agentid:<base58(ed25519_public_key_bytes)>
 * Matches the Python SDK identity module exactly.
 */

import bs58 from "bs58";
import { generateKeypair as cryptoGenerateKeypair, toBase64, fromBase64 } from "./crypto.js";

export const DID_PREFIX = "did:agentid:";

// ── Keypair ───────────────────────────────────────────────────────────────────

export interface Keypair {
  privateKey: Uint8Array; // 32 raw bytes
  publicKey: Uint8Array;  // 32 raw bytes
}

/**
 * Generate a fresh Ed25519 keypair suitable for creating a new agent.
 * The private key should be persisted securely by the caller.
 */
export async function generateKeypair(): Promise<Keypair> {
  return cryptoGenerateKeypair();
}

// ── DID ───────────────────────────────────────────────────────────────────────

/**
 * Derive a DID from an Ed25519 public key.
 * Format: did:agentid:<base58-encoded-public-key>
 */
export function publicKeyToDid(publicKey: Uint8Array): string {
  return DID_PREFIX + bs58.encode(publicKey);
}

/**
 * Decode a DID back to its raw public key bytes.
 * Throws if the DID is malformed or the embedded key is not 32 bytes.
 */
export function didToPublicKey(did: string): Uint8Array {
  if (!did.startsWith(DID_PREFIX)) {
    throw new Error(`Invalid DID — must start with '${DID_PREFIX}'`);
  }
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(did.slice(DID_PREFIX.length));
  } catch {
    throw new Error("Invalid DID — base58 decoding failed");
  }
  // Ed25519 public keys are always exactly 32 bytes
  if (bytes.length !== 32) {
    throw new Error(
      `Invalid DID — expected 32-byte public key, got ${bytes.length}`
    );
  }
  return bytes;
}

// ── Base64 encoding for API / storage ────────────────────────────────────────

/** Encode a public key as base64 for transmission / storage. */
export function publicKeyToBase64(publicKey: Uint8Array): string {
  return toBase64(publicKey);
}

/** Decode a base64-encoded public key back to raw bytes. */
export function base64ToPublicKey(b64: string): Uint8Array {
  return fromBase64(b64);
}

// ── Legacy aliases (backward compat) ─────────────────────────────────────────

/** @deprecated Use publicKeyToDid */
export const publicKeyToB64 = publicKeyToBase64;
/** @deprecated Use base64ToPublicKey */
export const b64ToPublicKeyBytes = base64ToPublicKey;
/** @deprecated Use didToPublicKey */
export const didToPublicKeyBytes = didToPublicKey;
