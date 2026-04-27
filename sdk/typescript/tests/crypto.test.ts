import { describe, it, expect } from "@jest/globals";
import { sign, verify, generateKeypair } from "../src/crypto.js";

describe("crypto", () => {
  it("signs and verifies a payload", async () => {
    const { privateKey, publicKey } = await generateKeypair();
    const payload = { action: "test", value: 42 };
    const sig = await sign(privateKey, payload);
    expect(await verify(publicKey, payload, sig)).toBe(true);
  });

  it("rejects a tampered payload", async () => {
    const { privateKey, publicKey } = await generateKeypair();
    const payload = { action: "test", value: 42 };
    const sig = await sign(privateKey, payload);
    expect(await verify(publicKey, { ...payload, value: 99 }, sig)).toBe(false);
  });

  it("rejects a signature from a different key", async () => {
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    const payload = { action: "test" };
    const sig = await sign(kp1.privateKey, payload);
    expect(await verify(kp2.publicKey, payload, sig)).toBe(false);
  });

  it("canonical JSON sorts keys the same as Python", async () => {
    // Python: json.dumps({"z": 1, "a": 2}, sort_keys=True, separators=(",",":"))
    // = '{"a":2,"z":1}'
    const { privateKey, publicKey } = await generateKeypair();
    const payload = { z: 1, a: 2 };
    const sig = await sign(privateKey, payload);
    // Different insertion order, same canonical form — must verify.
    expect(await verify(publicKey, { a: 2, z: 1 }, sig)).toBe(true);
  });

  it("rejects an invalid base64 signature gracefully", async () => {
    const { publicKey } = await generateKeypair();
    expect(await verify(publicKey, { x: 1 }, "not-valid-base64!!")).toBe(false);
  });
});
