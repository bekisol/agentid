/**
 * DID and keypair utilities for AgentID.
 * Matches the Python SDK identity module exactly.
 *
 * DID format: did:agentid:<base58(ed25519_public_key_bytes)>
 */

import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { toBase64, fromBase64 } from "./crypto.js";

export const DID_PREFIX = "did:agentid:";

// ── Keypair ───────────────────────────────────────────────────────────────────

export interface Keypair {
  privateKey: Uint8Array; // 32 raw bytes
  publicKey: Uint8Array;  // 32 raw bytes
}

export function generateKeypair(): Keypair {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

// ── DID ───────────────────────────────────────────────────────────────────────

export function publicKeyToDid(publicKeyBytes: Uint8Array): string {
  return DID_PREFIX + bs58.encode(publicKeyBytes);
}

export function didToPublicKeyBytes(did: string): Uint8Array {
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
    throw new Error(`Invalid DID — expected 32-byte public key, got ${bytes.length}`);
  }
  return bytes;
}

// ── Base64 encoding for public key storage ────────────────────────────────────

export function publicKeyToB64(publicKeyBytes: Uint8Array): string {
  return toBase64(publicKeyBytes);
}

export function b64ToPublicKeyBytes(b64: string): Uint8Array {
  return fromBase64(b64);
}
