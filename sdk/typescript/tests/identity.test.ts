import { describe, it, expect } from "@jest/globals";
import {
  generateKeypair,
  publicKeyToDid,
  didToPublicKey,
  publicKeyToBase64,
  base64ToPublicKey,
  DID_PREFIX,
} from "../src/identity.js";

describe("identity", () => {
  it("generates a unique keypair each time", async () => {
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    expect(kp1.privateKey).not.toEqual(kp2.privateKey);
    expect(kp1.publicKey).not.toEqual(kp2.publicKey);
    expect(kp1.privateKey).toHaveLength(32);
    expect(kp1.publicKey).toHaveLength(32);
  });

  it("DID starts with the correct prefix", async () => {
    const { publicKey } = await generateKeypair();
    const did = publicKeyToDid(publicKey);
    expect(did.startsWith(DID_PREFIX)).toBe(true);
  });

  it("round-trips DID → public key bytes", async () => {
    const { publicKey } = await generateKeypair();
    const did = publicKeyToDid(publicKey);
    const recovered = didToPublicKey(did);
    expect(recovered).toEqual(publicKey);
  });

  it("round-trips public key bytes → base64 → bytes", async () => {
    const { publicKey } = await generateKeypair();
    const b64 = publicKeyToBase64(publicKey);
    const recovered = base64ToPublicKey(b64);
    expect(recovered).toEqual(publicKey);
  });

  it("throws on an invalid DID prefix", () => {
    expect(() => didToPublicKey("did:wrong:abc")).toThrow();
  });

  it("throws on an invalid DID with malformed base58", () => {
    // A DID with the right prefix but garbage base58.
    expect(() => didToPublicKey("did:agentid:0OIl")).toThrow();
  });
});
