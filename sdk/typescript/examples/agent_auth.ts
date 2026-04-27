/**
 * Agent-to-Agent Authentication Demo
 *
 * Shows how two agents can establish mutual trust without a live registry:
 *   1. Agent A signs a message.
 *   2. Agent B verifies Agent A's identity using A's public key directly.
 *   3. Tamper detection — modifying the payload invalidates the signature.
 *
 * To run (after building):
 *   node --loader ts-node/esm examples/agent_auth.ts
 * or compile first:
 *   npx tsc && node dist/examples/agent_auth.js
 */

import { createAgent, Agent } from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function hr(label: string): void {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${label}`);
  console.log("─".repeat(60));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  hr("1. Create two agents (local, no registry needed)");

  // No registry → agents are created offline, no HTTP calls made.
  const agentA = await createAgent({
    name: "data-collector",
    capabilities: ["web-search", "scraping"],
    owner: "team-a@example.com",
  });

  const agentB = await createAgent({
    name: "analyst",
    capabilities: ["summarization", "reasoning"],
    owner: "team-b@example.com",
  });

  console.log("Agent A:", agentA.toString());
  console.log("Agent B:", agentB.toString());

  // ── Agent A signs a message ────────────────────────────────────────────────

  hr("2. Agent A signs a task request");

  const taskRequest = {
    action: "summarise",
    url: "https://example.com/article",
    priority: "high",
  };

  const signedMsg = await agentA.sign(taskRequest);

  console.log("Signed message:");
  console.log(JSON.stringify(signedMsg, null, 2));

  // ── Agent B verifies Agent A's identity ───────────────────────────────────

  hr("3. Agent B verifies Agent A's message (local key)");

  // In a real system Agent B would fetch Agent A's document from the registry.
  // Here we simulate by restoring Agent A from its exported private key so we
  // can call verifyLocal — the private key gives us the matching public key.
  const agentARestored = await Agent.fromPrivateKey(agentA.exportPrivateKey());

  const isValid = await agentARestored.verifyLocal(signedMsg);
  console.log(`Signature valid: ${isValid}`);           // true
  console.log(`Signer DID:      ${signedMsg.signer_did}`);
  console.log(`Timestamp (ms):  ${signedMsg.timestamp}`);
  console.log(`Nonce:           ${signedMsg.nonce}`);

  // ── Tamper detection ──────────────────────────────────────────────────────

  hr("4. Tamper detection — modify the payload and re-verify");

  const tamperedMsg = {
    ...signedMsg,
    payload: {
      ...signedMsg.payload,
      priority: "low",   // attacker changes the priority
    },
  };

  const isValidAfterTamper = await agentARestored.verifyLocal(tamperedMsg);
  console.log(`Signature valid after tamper: ${isValidAfterTamper}`);  // false
  console.log("Tamper detected correctly:", !isValidAfterTamper);

  // ── Wrong signer ──────────────────────────────────────────────────────────

  hr("5. Verify with the wrong public key (Agent B tries to verify A's message)");

  // Agent B verifying its own public key against A's signature — should fail.
  const wrongVerify = await agentB.verifyLocal(signedMsg);
  console.log(`Valid with wrong key: ${wrongVerify}`);  // false
  console.log("Wrong-key rejection correct:", !wrongVerify);

  // ── Key persistence round-trip ─────────────────────────────────────────────

  hr("6. Export + restore private key — DID is stable");

  const rawKey = agentA.exportPrivateKey();
  const agentALoaded = await Agent.fromPrivateKey(rawKey);

  console.log("Original DID:  ", agentA.did);
  console.log("Restored DID:  ", agentALoaded.did);
  console.log("DIDs match:", agentA.did === agentALoaded.did);

  // Sign a second message with the restored agent and verify with the original.
  const secondMsg = await agentALoaded.sign({ task: "verify-me" });
  const secondValid = await agentARestored.verifyLocal(secondMsg);
  console.log("Message from restored agent verifies:", secondValid);

  hr("Done");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
