"""
AgentID Registry Server

A lightweight FastAPI server that acts as a public registry for agent documents.
Run with: uvicorn server:app --reload
"""

import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import psycopg2
import psycopg2.extras
from fastapi import FastAPI, HTTPException, Query, Request
from pydantic import BaseModel, field_validator
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

import sys
_sdk_path = Path(__file__).parent.parent / "sdk" / "python"
if _sdk_path.exists():
    sys.path.insert(0, str(_sdk_path))

from agentid.crypto import verify as crypto_verify
from agentid.identity import b64_to_public_key_bytes, public_key_to_did

# ── rate limiter ──────────────────────────────────────────────────────────────

limiter = Limiter(key_func=get_remote_address)

app = FastAPI(
    title="AgentID Registry",
    description="Public registry for AI agent identity and discovery",
    version="0.1.1",
)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


# ── database ──────────────────────────────────────────────────────────────────

def get_conn():
    return psycopg2.connect(os.environ["DATABASE_URL"], sslmode="require")


def init_db():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS agents (
                    did          TEXT PRIMARY KEY,
                    name         TEXT NOT NULL,
                    capabilities JSONB NOT NULL,
                    owner        TEXT NOT NULL,
                    public_key   TEXT NOT NULL,
                    created_at   TEXT NOT NULL,
                    metadata     JSONB NOT NULL DEFAULT '{}'
                )
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_agents_name  ON agents(lower(name))")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS audit_log (
                    id         SERIAL PRIMARY KEY,
                    ts         TEXT NOT NULL,
                    operation  TEXT NOT NULL,
                    did        TEXT,
                    ip         TEXT,
                    status     TEXT
                )
            """)
        conn.commit()


@app.on_event("startup")
def startup():
    init_db()


# ── helpers ───────────────────────────────────────────────────────────────────

def _audit(operation: str, did: str = None, ip: str = None, status: str = "ok"):
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO audit_log (ts, operation, did, ip, status) VALUES (%s,%s,%s,%s,%s)",
                    (datetime.now(timezone.utc).isoformat(), operation, did, ip, status),
                )
            conn.commit()
    except Exception:
        pass  # never let audit failure break a request


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


# ── request / response models ─────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    did: str
    name: str
    capabilities: list[str]
    owner: str
    public_key: str
    created_at: str
    metadata: dict = {}
    proof: Optional[str] = None  # Ed25519 signature of the document — proves key ownership

    @field_validator("name")
    @classmethod
    def validate_name(cls, v):
        if len(v) > 256:
            raise ValueError("name too long (max 256 chars)")
        return v

    @field_validator("owner")
    @classmethod
    def validate_owner(cls, v):
        if len(v) > 256:
            raise ValueError("owner too long (max 256 chars)")
        return v

    @field_validator("capabilities")
    @classmethod
    def validate_capabilities(cls, v):
        if len(v) > 100:
            raise ValueError("too many capabilities (max 100)")
        for cap in v:
            if not isinstance(cap, str) or len(cap) > 128:
                raise ValueError(f"capability too long: {cap}")
            if not re.match(r'^[a-zA-Z0-9_-]+$', cap):
                raise ValueError(f"capability must be alphanumeric/dash/underscore: {cap}")
        return v

    @field_validator("metadata")
    @classmethod
    def validate_metadata(cls, v):
        if len(json.dumps(v)) > 10_000:
            raise ValueError("metadata too large (max 10KB)")
        return v


class VerifyRequest(BaseModel):
    payload: dict
    signature: str


class DeregisterRequest(BaseModel):
    payload: dict   # must contain {"action": "deregister", "did": "...", "timestamp": ...}
    signature: str  # signed by the agent's private key


class AgentResponse(BaseModel):
    did: str
    name: str
    capabilities: list[str]
    owner: str
    public_key: str
    created_at: str
    metadata: dict


# ── routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "timestamp": time.time()}


@app.post("/agents", response_model=AgentResponse, status_code=201)
@limiter.limit("20/minute")
def register_agent(req: RegisterRequest, request: Request):
    ip = request.client.host

    # Fix #2 — verify DID is cryptographically derived from the submitted public key
    try:
        pub_key_bytes = b64_to_public_key_bytes(req.public_key)
        expected_did = public_key_to_did(pub_key_bytes)
    except Exception:
        _audit("register", req.did, ip, "invalid_key")
        raise HTTPException(status_code=400, detail="Invalid public key")

    if req.did != expected_did:
        _audit("register", req.did, ip, "did_mismatch")
        raise HTTPException(status_code=400, detail="DID does not match public key")

    # Fix #2 — verify proof of key possession (signature over the document)
    if req.proof:
        payload_to_verify = req.model_dump(exclude={"proof"})
        if not crypto_verify(pub_key_bytes, payload_to_verify, req.proof):
            _audit("register", req.did, ip, "invalid_proof")
            raise HTTPException(status_code=401, detail="Invalid proof of ownership")

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT did FROM agents WHERE did = %s", (req.did,))
            if cur.fetchone():
                _audit("register", req.did, ip, "conflict")
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

    _audit("register", req.did, ip)
    return AgentResponse(**req.model_dump(exclude={"proof"}))


@app.get("/agents/{did}", response_model=AgentResponse)
@limiter.limit("120/minute")
def resolve_agent(did: str, request: Request):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT did, name, capabilities, owner, public_key, created_at, metadata FROM agents WHERE did = %s",
                (did,),
            )
            row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Agent not found")
    return AgentResponse(**row_to_dict(row))


@app.get("/agents", response_model=list[AgentResponse])
@limiter.limit("60/minute")
def discover_agents(
    request: Request,
    capability: Optional[str] = Query(None, max_length=128),
    owner: Optional[str] = Query(None, max_length=256),
    name: Optional[str] = Query(None, max_length=256),
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
@limiter.limit("60/minute")
def verify_signature(did: str, req: VerifyRequest, request: Request):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT public_key FROM agents WHERE did = %s", (did,))
            row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Agent not found")

    # Fix #8 — reject signatures older than 5 minutes
    timestamp = req.payload.get("timestamp")
    if timestamp and (time.time() - float(timestamp)) > 300:
        return {"valid": False, "did": did, "reason": "signature expired"}

    public_key_bytes = b64_to_public_key_bytes(row[0])
    valid = crypto_verify(public_key_bytes, req.payload, req.signature)
    return {"valid": valid, "did": did}


@app.delete("/agents/{did}", status_code=204)
@limiter.limit("10/minute")
def deregister_agent(did: str, req: DeregisterRequest, request: Request):
    ip = request.client.host

    # Fix #1 — verify cryptographic ownership instead of trusting owner string
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT public_key FROM agents WHERE did = %s", (did,))
            row = cur.fetchone()

    # Fix #12 — same error whether not found or wrong key (prevents enumeration)
    if not row:
        _audit("deregister", did, ip, "forbidden")
        raise HTTPException(status_code=403, detail="Forbidden")

    if req.payload.get("action") != "deregister" or req.payload.get("did") != did:
        _audit("deregister", did, ip, "invalid_payload")
        raise HTTPException(status_code=400, detail="Invalid deregister payload")

    public_key_bytes = b64_to_public_key_bytes(row[0])
    if not crypto_verify(public_key_bytes, req.payload, req.signature):
        _audit("deregister", did, ip, "forbidden")
        raise HTTPException(status_code=403, detail="Forbidden")

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM agents WHERE did = %s", (did,))
        conn.commit()

    _audit("deregister", did, ip)
