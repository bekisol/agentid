import { describe, it, expect } from "@jest/globals";
import { sign, verify } from "../src/crypto.js";
import { generateKeypair } from "../src/identity.js";

describe("crypto", () => {
  it("signs and verifies a payload", () => {
    const { privateKey, publicKey } = generateKeypair();
    const payload = { action: "test", value: 42 };
    const sig = sign(privateKey, payload);
    expect(verify(publicKey, payload, sig)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const { privateKey, publicKey } = generateKeypair();
    const payload = { action: "test", value: 42 };
    const sig = sign(privateKey, payload);
    expect(verify(publicKey, { ...payload, value: 99 }, sig)).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();
    const payload = { action: "test" };
    const sig = sign(kp1.privateKey, payload);
    expect(verify(kp2.publicKey, payload, sig)).toBe(false);
  });

  it("canonical JSON sorts keys the same as Python", () => {
    // Python: json.dumps({"z": 1, "a": 2}, sort_keys=True, separators=(",",":"))
    // = '{"a":2,"z":1}'
    const { privateKey, publicKey } = generateKeypair();
    const payload = { z: 1, a: 2 };
    const sig = sign(privateKey, payload);
    // The same payload with different key order must verify (canonical handles it)
    const payloadReordered = { a: 2, z: 1 };
    expect(verify(publicKey, payloadReordered, sig)).toBe(true);
  });

  it("rejects an invalid base64 signature gracefully", () => {
    const { publicKey } = generateKeypair();
    expect(verify(publicKey, { x: 1 }, "not-valid-base64!!")).toBe(false);
  });
});
