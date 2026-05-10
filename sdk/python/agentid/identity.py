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


# Multicodec prefix for Ed25519 public keys (varint 0xED 0x01)
_ED25519_MULTICODEC_PREFIX = bytes([0xED, 0x01])


def public_key_to_multibase(public_bytes: bytes) -> str:
    """Encode an Ed25519 public key as multibase base58btc (z-prefixed).

    Format: ``z`` + base58btc(varint(0xED01) + raw_key_bytes)

    This is the encoding required by the W3C DID Core spec for
    ``publicKeyMultibase`` fields in ``Ed25519VerificationKey2020``
    verification methods.  The ``z`` prefix is the multibase prefix for
    base58btc; the ``0xED 0x01`` varint is the multicodec tag for Ed25519.

    Correct:  ``z6Mk...``  (32-byte Ed25519 key → 34-byte prefixed → base58btc)
    Wrong:    ``AAAA...``  (bare base64 — no multibase prefix, no multicodec)
    """
    prefixed = _ED25519_MULTICODEC_PREFIX + public_bytes
    return "z" + base58.b58encode(prefixed).decode()


def b64_to_public_key_bytes(b64: str) -> bytes:
    try:
        raw = base64.b64decode(b64, validate=True)
    except Exception:
        raise ValueError("Invalid base64 encoding for public key")
    if len(raw) != 32:
        raise ValueError(f"Ed25519 public key must be 32 bytes, got {len(raw)}")
    return raw
