import base64
import base58
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding, PublicFormat, PrivateFormat, NoEncryption
)

DID_PREFIX = "did:agentid:"


def generate_keypair() -> tuple[bytes, bytes]:
    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key()
    private_bytes = private_key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    public_bytes = public_key.public_bytes(Encoding.Raw, PublicFormat.Raw)
    return private_bytes, public_bytes


def public_key_to_did(public_bytes: bytes) -> str:
    return DID_PREFIX + base58.b58encode(public_bytes).decode()


def did_to_public_key_bytes(did: str) -> bytes:
    if not did.startswith(DID_PREFIX):
        raise ValueError(f"Invalid DID: {did}")
    return base58.b58decode(did[len(DID_PREFIX):])


def public_key_to_b64(public_bytes: bytes) -> str:
    return base64.b64encode(public_bytes).decode()


def b64_to_public_key_bytes(b64: str) -> bytes:
    try:
        raw = base64.b64decode(b64, validate=True)
    except Exception:
        raise ValueError("Invalid base64 encoding for public key")
    if len(raw) != 32:
        raise ValueError(f"Ed25519 public key must be 32 bytes, got {len(raw)}")
    return raw
