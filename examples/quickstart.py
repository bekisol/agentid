"""
AgentID Quickstart

Two modes:
  - Local registry  (default, no server needed)
  - Remote registry (pass registry_url, requires server running)

Run local:   python quickstart.py
Run remote:  python quickstart.py --remote http://localhost:8000
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "sdk" / "python"))

from agentid import Agent

# ── parse args ────────────────────────────────────────────────────────────────

registry_url = None
if "--remote" in sys.argv:
    idx = sys.argv.index("--remote")
    registry_url = sys.argv[idx + 1]
    print(f"=== Using remote registry: {registry_url} ===\n")
else:
    print("=== Using local registry (~/.agentid/) ===\n")

kwargs = {"registry_url": registry_url} if registry_url else {}

# ── 1. Create agents ──────────────────────────────────────────────────────────

print("--- Creating agents ---")

planner = Agent.create(
    name="calendar-planner",
    capabilities=["scheduling", "calendar-management"],
    owner="alice@company.com",
    **kwargs,
)
print(f"  {planner}")

travel = Agent.create(
    name="travel-booker",
    capabilities=["flight-search", "hotel-booking", "itinerary-planning"],
    owner="bob@company.com",
    **kwargs,
)
print(f"  {travel}")

# ── 2. Discover by capability ─────────────────────────────────────────────────

print("\n--- Discovering agents ---")

flight_agents = Agent.find(capability="flight-search", **kwargs)
print(f"  'flight-search' agents: {[a.name for a in flight_agents]}")

scheduling_agents = Agent.find(capability="scheduling", **kwargs)
print(f"  'scheduling' agents:    {[a.name for a in scheduling_agents]}")

# ── 3. Resolve a DID ─────────────────────────────────────────────────────────

print("\n--- Resolving a DID ---")

resolved = Agent.resolve(travel.did, **kwargs)
print(f"  DID:          {travel.did[:50]}...")
print(f"  name:         {resolved.name}")
print(f"  capabilities: {resolved.capabilities}")
print(f"  owner:        {resolved.owner}")

# ── 4. Sign and verify ────────────────────────────────────────────────────────

print("\n--- Signing and verifying ---")

task = {"task": "Book flight SFO → NYC, March 15, economy, under $400"}
signed = planner.sign(task)

print(f"  Signer:    {signed['payload']['signer'][:50]}...")
print(f"  Signature: {signed['signature'][:50]}...")

valid = planner.verify_message(signed)
print(f"  Valid (agent object): {valid}")

valid_did = Agent.verify_from_did(signed, **kwargs)
print(f"  Valid (from DID):     {valid_did}")

tampered = {"payload": {**signed["payload"], "task": "Book first class"}, "signature": signed["signature"]}
print(f"  Tampered valid:       {Agent.verify_from_did(tampered, **kwargs)}")

print("\nDone.")
