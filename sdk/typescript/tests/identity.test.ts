import { describe, it, expect } from "@jest/globals";
import {
  generateKeypair,
  publicKeyToDid,
  didToPublicKeyBytes,
  publicKeyToB64,
  b64ToPublicKeyBytes,
  DID_PREFIX,
} from "../src/identity.js";

describe("identity", () => {
  it("generates a unique keypair each time", () => {
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();
    expect(kp1.privateKey).not.toEqual(kp2.privateKey);
    expect(kp1.publicKey).not.toEqual(kp2.publicKey);
    expect(kp1.privateKey).toHaveLength(32);
    expect(kp1.publicKey).toHaveLength(32);
  });

  it("DID starts with the correct prefix", () => {
    const { publicKey } = generateKeypair();
    const did = publicKeyToDid(publicKey);
    expect(did.startsWith(DID_PREFIX)).toBe(true);
  });

  it("round-trips DID → public key bytes", () => {
    const { publicKey } = generateKeypair();
    const did = publicKeyToDid(publicKey);
    const recovered = didToPublicKeyBytes(did);
    expect(recovered).toEqual(publicKey);
  });

  it("round-trips public key bytes → base64 → bytes", () => {
    const { publicKey } = generateKeypair();
    const b64 = publicKeyToB64(publicKey);
    const recovered = b64ToPublicKeyBytes(b64);
    expect(recovered).toEqual(publicKey);
  });

  it("throws on an invalid DID", () => {
    expect(() => didToPublicKeyBytes("did:wrong:abc")).toThrow();
  });
});
