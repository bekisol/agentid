"""
AgentID — Agent Authentication Demo
=====================================
Scenario: A "Coordinator" agent wants to dispatch a sensitive task to a
"Worker" agent.  Before accepting the task, Worker must prove its identity
to Coordinator, and Worker must verify Coordinator's identity before acting.

Protocol steps
--------------
1. Worker sends a signed "hello" handshake to Coordinator.
2. Coordinator looks the Worker DID up in the registry, verifies the
   signature, and checks that Worker has the required capability.
3. Coordinator signs and sends a task-assignment message back.
4. Worker verifies Coordinator's signature before accepting the task.
5. Tamper test — an attacker modifies the in-flight message; verification
   must fail and the task must be rejected.

Run from the agentid repo root:
    python examples/agent_auth_demo.py
"""

import sys
import copy
import json
import tempfile
import shutil
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "sdk" / "python"))

from agentid import Agent

# ── ANSI colour helpers (graceful fallback on non-colour terminals) ────────────

RESET  = "\033[0m"
BOLD   = "\033[1m"
GREEN  = "\033[32m"
CYAN   = "\033[36m"
YELLOW = "\033[33m"
RED    = "\033[31m"
DIM    = "\033[2m"

def step(n: int, text: str):
    print(f"\n{BOLD}{CYAN}  Step {n}{RESET}  {text}")
    print(f"  {'─' * 60}")

def ok(msg: str):
    print(f"  {GREEN}✔  {msg}{RESET}")

def warn(msg: str):
    print(f"  {YELLOW}⚠  {msg}{RESET}")

def fail(msg: str):
    print(f"  {RED}✘  {msg}{RESET}")

def show_dict(label: str, d: dict, truncate_keys=("signature",)):
    """Pretty-print a dict, truncating long values for readability."""
    print(f"\n  {DIM}{label}{RESET}")
    for k, v in d.items():
        if isinstance(v, dict):
            print(f"    {k}:")
            for ik, iv in v.items():
                iv_str = str(iv)
                if ik in truncate_keys and len(iv_str) > 40:
                    iv_str = iv_str[:40] + "…"
                print(f"      {ik}: {iv_str}")
        else:
            v_str = str(v)
            if k in truncate_keys and len(v_str) > 40:
                v_str = v_str[:40] + "…"
            print(f"    {k}: {v_str}")

def did_short(did: str) -> str:
    return did[:26] + "…" + did[-6:]


# ── Main demo ─────────────────────────────────────────────────────────────────

def main():
    registry_dir = tempfile.mkdtemp(prefix="agentid_auth_demo_")
    try:
        _run_demo(registry_dir)
    finally:
        shutil.rmtree(registry_dir, ignore_errors=True)
        print(f"\n  {DIM}Temp registry cleaned up: {registry_dir}{RESET}\n")


def _run_demo(registry_dir: str):
    reg = {"registry_path": registry_dir}

    print()
    print(f"{BOLD}{'═' * 64}{RESET}")
    print(f"{BOLD}   🤝  AgentID — Mutual Authentication Demo{RESET}")
    print(f"{BOLD}{'═' * 64}{RESET}")
    print("""
  Two agents must prove their identities to each other before any
  sensitive work can be delegated.  Every message is signed with the
  sender's Ed25519 private key and verified against the public key
  recorded in the shared registry.
""")

    # ── Step 1: Register agents ───────────────────────────────────────────────
    step(1, "Register agents in local registry")

    coordinator = Agent.create(
        name="Coordinator-Prime",
        capabilities=["task-dispatch", "fleet-management", "audit"],
        owner="ops-team@acme.io",
        metadata={"env": "production", "region": "us-east-1"},
        **reg,
    )
    ok(f"Coordinator registered  DID: {did_short(coordinator.did)}")

    worker = Agent.create(
        name="Worker-Node-7",
        capabilities=["data-ingestion", "file-processing", "report-generation"],
        owner="ops-team@acme.io",
        metadata={"env": "production", "node": "worker-07"},
        **reg,
    )
    ok(f"Worker registered       DID: {did_short(worker.did)}")

    # ── Step 2: Worker sends a signed hello ───────────────────────────────────
    step(2, "Worker sends a signed 'hello' handshake to Coordinator")

    hello_payload = {
        "type": "handshake/hello",
        "from_name": worker.name,
        "capabilities": worker.capabilities,
        "message": "Requesting authorization to receive task assignments.",
    }
    hello_msg = worker.sign(hello_payload)

    show_dict("Signed hello message:", hello_msg)
    ok("Worker signed hello with its Ed25519 private key")

    # ── Step 3: Coordinator verifies Worker's identity ────────────────────────
    step(3, "Coordinator verifies Worker's identity via registry lookup")

    # Coordinator extracts the claimed DID from the message payload
    claimed_did = hello_msg["payload"]["signer"]
    print(f"\n    Claimed DID : {did_short(claimed_did)}")

    # Resolve the DID — fetches the public key from the registry
    worker_doc = Agent.resolve(claimed_did, **reg)
    if worker_doc is None:
        fail("DID not found in registry — rejecting handshake")
        return

    ok(f"DID resolved  → {worker_doc.name}  owner={worker_doc.owner}")

    # Verify the cryptographic signature (pass verifier_did to log the relationship)
    sig_valid = Agent.verify_from_did(hello_msg, **reg, verifier_did=coordinator.did)
    if not sig_valid:
        fail("Signature verification failed — rejecting handshake")
        return
    ok("Signature verified  ✔  message is authentic")

    # Check that Worker has the required capability
    required_cap = "file-processing"
    if required_cap not in worker_doc.capabilities:
        fail(f"Worker lacks required capability: '{required_cap}'")
        return
    ok(f"Capability check passed  → Worker has '{required_cap}'")

    # ── Step 4: Coordinator issues a signed task assignment ───────────────────
    step(4, "Coordinator signs and sends a task assignment to Worker")

    task_payload = {
        "type": "task/assignment",
        "task_id": "task-20260427-001",
        "worker_did": worker.did,
        "action": "process_sensor_batch",
        "parameters": {
            "source_bucket": "s3://acme-raw/sensor-2026-04-27/",
            "output_bucket": "s3://acme-processed/2026-04-27/",
            "format": "parquet",
            "priority": "high",
        },
        "deadline_utc": "2026-04-27T18:00:00Z",
    }
    task_msg = coordinator.sign(task_payload)

    show_dict("Signed task assignment:", task_msg)
    ok("Coordinator signed task with its Ed25519 private key")

    # ── Step 5: Worker verifies Coordinator's identity ────────────────────────
    step(5, "Worker verifies Coordinator's identity before accepting the task")

    coord_did = task_msg["payload"]["signer"]
    print(f"\n    Claimed DID : {did_short(coord_did)}")

    coord_doc = Agent.resolve(coord_did, **reg)
    if coord_doc is None:
        fail("Coordinator DID not found — rejecting task")
        return
    ok(f"DID resolved  → {coord_doc.name}  owner={coord_doc.owner}")

    coord_sig_valid = Agent.verify_from_did(task_msg, **reg, verifier_did=worker.did)
    if not coord_sig_valid:
        fail("Coordinator signature invalid — rejecting task")
        return
    ok("Coordinator signature verified  ✔")

    # Ensure the task was addressed to this worker
    if task_msg["payload"]["worker_did"] != worker.did:
        fail("Task is not addressed to this worker — ignoring")
        return
    ok(f"Task accepted  →  action='{task_payload['action']}'  id={task_payload['task_id']}")

    # ── Step 6: Tamper test ───────────────────────────────────────────────────
    step(6, "Tamper test — attacker intercepts and modifies the task")

    warn("Attacker modifies 'output_bucket' to redirect data exfiltration …")
    tampered_msg = copy.deepcopy(task_msg)
    tampered_msg["payload"]["parameters"]["output_bucket"] = "s3://evil-exfil-bucket/"
    show_dict("Tampered message (attacker's version):", tampered_msg)

    tampered_valid = Agent.verify_from_did(tampered_msg, **reg)
    if tampered_valid:
        fail("BUG: tampered message passed verification!")
    else:
        ok("Tampered message rejected — signature mismatch detected")
        ok("Worker safely ignores the tampered task")

    # ── Final summary ─────────────────────────────────────────────────────────
    print()
    print(f"{BOLD}{'═' * 64}{RESET}")
    print(f"{BOLD}   Summary{RESET}")
    print(f"{'─' * 64}")
    print(f"  {GREEN}✔{RESET}  Worker authenticated to Coordinator via signed handshake")
    print(f"  {GREEN}✔{RESET}  Coordinator authenticated to Worker via signed task msg")
    print(f"  {GREEN}✔{RESET}  Capability check enforced before task dispatch")
    print(f"  {GREEN}✔{RESET}  Tampered in-flight message correctly rejected")
    print(f"{BOLD}{'═' * 64}{RESET}")


if __name__ == "__main__":
    main()
