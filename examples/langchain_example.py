"""
AgentID × LangChain — complete example

Shows how to give any LangChain agent a verifiable identity
and how agents can discover and verify each other.

Run: python langchain_example.py
(No API key needed — uses a mock LLM)
"""

import sys
import json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "sdk" / "python"))

from unittest.mock import MagicMock, patch
from agentid import Agent
from agentid.integrations.langchain import (
    AgentIDCallbackHandler,
    AgentIDFindTool,
    AgentIDVerifyTool,
    AgentIDSignTool,
    verify_langchain_output,
)

REGISTRY = str(Path(__file__).parent / ".demo_registry")

print("=" * 60)
print("AgentID × LangChain Demo")
print("=" * 60)

# ── Step 1: Register two agents ───────────────────────────────────────────────

print("\n[1] Registering agents with verifiable identities...")

research_identity = AgentIDCallbackHandler(
    name="research-agent",
    capabilities=["web-search", "summarization", "fact-checking"],
    owner="alice@company.com",
    registry_path=REGISTRY,
)
print(f"    research-agent DID: {research_identity.did[:50]}...")

writer_identity = AgentIDCallbackHandler(
    name="writer-agent",
    capabilities=["content-writing", "editing", "summarization"],
    owner="bob@company.com",
    registry_path=REGISTRY,
)
print(f"    writer-agent DID:   {writer_identity.did[:50]}...")

# ── Step 2: Discovery ─────────────────────────────────────────────────────────

print("\n[2] Discovering agents by capability...")

find_tool = AgentIDFindTool(registry_path=REGISTRY)

summarizers = json.loads(find_tool._run("summarization"))
print(f"    Agents with 'summarization': {[a['name'] for a in summarizers]}")

writers = json.loads(find_tool._run("content-writing"))
print(f"    Agents with 'content-writing': {[a['name'] for a in writers]}")

missing = find_tool._run("quantum-computing")
print(f"    Agents with 'quantum-computing': {missing}")

# ── Step 3: Simulate AgentExecutor output ─────────────────────────────────────

print("\n[3] Simulating a research agent completing a task...")

finish = MagicMock()
finish.return_values = {
    "output": "Paris is the capital of France, with a population of 2.1 million."
}
research_identity.on_agent_finish(finish)

result = finish.return_values
print(f"    Output:    {result['output']}")
print(f"    Signer:    {result['_agentid_did'][:50]}...")
print(f"    Signature: {result['_agentid_signature'][:50]}...")

# ── Step 4: Verify the output ─────────────────────────────────────────────────

print("\n[4] Writer agent verifies research agent's output...")

verify_tool = AgentIDVerifyTool(registry_path=REGISTRY)

signed_msg = json.dumps({
    "payload": result["_agentid_payload"],
    "signature": result["_agentid_signature"],
})
verification = json.loads(verify_tool._run(signed_msg))
print(f"    Valid:   {verification['valid']}")
print(f"    Signer:  {verification['signer'][:50]}...")
print(f"    Message: {verification['message']}")

# ── Step 5: End-to-end verify via helper ──────────────────────────────────────

print("\n[5] End-to-end output verification...")

valid = verify_langchain_output(result, registry_path=REGISTRY)
print(f"    verify_langchain_output(): {valid}")

# Tamper check
tampered_result = {
    **result,
    "output": "TAMPERED: Rome is the capital of France.",
    "_agentid_payload": {**result["_agentid_payload"], "output": "TAMPERED: Rome is the capital of France."},
}
invalid = verify_langchain_output(tampered_result, registry_path=REGISTRY)
print(f"    Tampered output valid:     {invalid}")

# ── Step 6: Sign tool ─────────────────────────────────────────────────────────

print("\n[6] Writer agent signs its own output...")

sign_tool = AgentIDSignTool(agent=writer_identity.agent)
writer_output = json.loads(sign_tool._run(json.dumps({
    "article": "Paris, the City of Light, serves as France's capital..."
})))
print(f"    Signer:    {writer_output['payload']['signer'][:50]}...")
print(f"    Signature: {writer_output['signature'][:50]}...")

writer_valid = Agent.verify_from_did(writer_output, registry_path=REGISTRY)
print(f"    Verified:  {writer_valid}")

print("\n" + "=" * 60)
print("Done. Every message between agents is cryptographically verified.")
print("=" * 60)

# Cleanup demo registry
import shutil
shutil.rmtree(REGISTRY, ignore_errors=True)
