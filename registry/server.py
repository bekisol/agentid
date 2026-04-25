"""
AgentID Registry Server

A lightweight FastAPI server that acts as a public registry for agent documents.
Run with: uvicorn server:app --reload
"""

import json
import os
import time
from pathlib import Path
from typing import Optional

import psycopg2
import psycopg2.extras
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel

import sys
_sdk_path = Path(__file__).parent.parent / "sdk" / "python"
if _sdk_path.exists():
    sys.path.insert(0, str(_sdk_path))

from agentid.crypto import verify as crypto_verify
from agentid.identity import b64_to_public_key_bytes

app = FastAPI(
    title="AgentID Registry",
    description="Public registry for AI agent identity and discovery",
    version="0.1.0",
)


# ── database ──────────────────────────────────────────────────────────────────

def get_conn():
    return psycopg2.connect(os.environ["DATABASE_URL"], sslmode="require")


def init_db():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS agents (
                    did         TEXT PRIMARY KEY,
                    name        TEXT NOT NULL,
                    capabilities JSONB NOT NULL,
                    owner       TEXT NOT NULL,
                    public_key  TEXT NOT NULL,
                    created_at  TEXT NOT NULL,
                    metadata    JSONB NOT NULL DEFAULT '{}'
                )
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_agents_name  ON agents(lower(name))")
        conn.commit()


@app.on_event("startup")
def startup():
    init_db()


# ── request / response models ─────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    did: str
    name: str
    capabilities: list[str]
    owner: str
    public_key: str
    created_at: str
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
    created_at: str
    metadata: dict


# ── helpers ───────────────────────────────────────────────────────────────────

def row_to_dict(row) -> dict:
    return {
        "did":          row[0],
        "name":         row[1],
        "capabilities": row[2],
        "owner":        row[3],
        "public_key":   row[4],
        "created_at":   row[5],
        "metadata":     row[6],
    }


# ── routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "timestamp": time.time()}


@app.post("/agents", response_model=AgentResponse, status_code=201)
def register_agent(req: RegisterRequest):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT did FROM agents WHERE did = %s", (req.did,))
            if cur.fetchone():
                raise HTTPException(status_code=409, detail="Agent already registered")

            cur.execute("""
                INSERT INTO agents (did, name, capabilities, owner, public_key, created_at, metadata)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
            """, (
                req.did,
                req.name,
                json.dumps(req.capabilities),
                req.owner,
                req.public_key,
                req.created_at,
                json.dumps(req.metadata),
            ))
        conn.commit()

    return AgentResponse(**req.model_dump())


@app.get("/agents/{did}", response_model=AgentResponse)
def resolve_agent(did: str):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT did, name, capabilities, owner, public_key, created_at, metadata FROM agents WHERE did = %s", (did,))
            row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Agent not found")
    return AgentResponse(**row_to_dict(row))


@app.get("/agents", response_model=list[AgentResponse])
def discover_agents(
    capability: Optional[str] = Query(None),
    owner: Optional[str] = Query(None),
    name: Optional[str] = Query(None),
):
    query = "SELECT did, name, capabilities, owner, public_key, created_at, metadata FROM agents WHERE 1=1"
    params = []

    if owner:
        query += " AND owner = %s"
        params.append(owner)
    if name:
        query += " AND lower(name) LIKE %s"
        params.append(f"%{name.lower()}%")
    if capability:
        query += " AND capabilities @> %s"
        params.append(json.dumps([capability]))

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(query, params)
            rows = cur.fetchall()

    return [AgentResponse(**row_to_dict(r)) for r in rows]


@app.post("/agents/{did}/verify")
def verify_signature(did: str, req: VerifyRequest):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT public_key FROM agents WHERE did = %s", (did,))
            row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Agent not found")

    public_key_bytes = b64_to_public_key_bytes(row[0])
    valid = crypto_verify(public_key_bytes, req.payload, req.signature)
    return {"valid": valid, "did": did}


@app.delete("/agents/{did}", status_code=204)
def deregister_agent(did: str, owner: str = Query(...)):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT owner FROM agents WHERE did = %s", (did,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Agent not found")
            if row[0] != owner:
                raise HTTPException(status_code=403, detail="Only the owner can deregister")
            cur.execute("DELETE FROM agents WHERE did = %s", (did,))
        conn.commit()
