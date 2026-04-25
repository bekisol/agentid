"""
AgentID Registry Server

A lightweight FastAPI server that acts as a public registry for agent documents.
Run with: uvicorn server:app --reload
"""

import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel

import sys
sys.path.insert(0, str(Path(__file__).parent.parent / "sdk" / "python"))

from agentid.agent import AgentDocument
from agentid.registry import Registry
from agentid.crypto import verify as crypto_verify
from agentid.identity import b64_to_public_key_bytes

app = FastAPI(
    title="AgentID Registry",
    description="Public registry for AI agent identity and discovery",
    version="0.1.0",
)

REGISTRY = Registry(path=Path(__file__).parent / "data")


# ── request / response models ─────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    did: str
    name: str
    capabilities: list[str]
    owner: str
    public_key: str
    created_at: float
    metadata: dict = {}


class VerifyRequest(BaseModel):
    payload: dict
    signature: str


class AgentResponse(BaseModel):
    did: str
    name: str
    capabilities: list[str]
    owner: str
    public_key: str
    created_at: float
    metadata: dict


# ── routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "timestamp": time.time()}


@app.post("/agents", response_model=AgentResponse, status_code=201)
def register_agent(req: RegisterRequest):
    existing = REGISTRY.get(req.did)
    if existing:
        raise HTTPException(status_code=409, detail="Agent already registered")

    document = AgentDocument(
        did=req.did,
        name=req.name,
        capabilities=req.capabilities,
        owner=req.owner,
        public_key=req.public_key,
        created_at=req.created_at,
        metadata=req.metadata,
    )

    # Registry server doesn't store private keys — public registry only
    REGISTRY.db_path.parent.mkdir(parents=True, exist_ok=True)
    import json
    from dataclasses import asdict
    db_path = REGISTRY.db_path
    db = {}
    if db_path.exists():
        with open(db_path) as f:
            db = json.load(f)
    db[document.did] = asdict(document)
    with open(db_path, "w") as f:
        json.dump(db, f, indent=2)

    return AgentResponse(**asdict(document))


@app.get("/agents/{did}", response_model=AgentResponse)
def resolve_agent(did: str):
    data = REGISTRY.get(did)
    if not data:
        raise HTTPException(status_code=404, detail="Agent not found")
    return AgentResponse(**data)


@app.get("/agents", response_model=list[AgentResponse])
def discover_agents(
    capability: Optional[str] = Query(None),
    owner: Optional[str] = Query(None),
):
    results = REGISTRY.search(capability=capability, owner=owner)
    return [AgentResponse(**d) for d in results]


@app.post("/agents/{did}/verify")
def verify_signature(did: str, req: VerifyRequest):
    data = REGISTRY.get(did)
    if not data:
        raise HTTPException(status_code=404, detail="Agent not found")

    from agentid.identity import b64_to_public_key_bytes
    public_key_bytes = b64_to_public_key_bytes(data["public_key"])
    valid = crypto_verify(public_key_bytes, req.payload, req.signature)

    return {"valid": valid, "did": did}


@app.delete("/agents/{did}", status_code=204)
def deregister_agent(did: str, owner: str = Query(...)):
    data = REGISTRY.get(did)
    if not data:
        raise HTTPException(status_code=404, detail="Agent not found")
    if data.get("owner") != owner:
        raise HTTPException(status_code=403, detail="Only the owner can deregister")
    REGISTRY.deregister(did)
