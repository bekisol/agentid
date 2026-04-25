import base64
import json

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey, Ed25519PublicKey
)
from cryptography.exceptions import InvalidSignature


def _canonical(payload: dict) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()


def sign(private_key_bytes: bytes, payload: dict) -> str:
    key = Ed25519PrivateKey.from_private_bytes(private_key_bytes)
    signature = key.sign(_canonical(payload))
    return base64.b64encode(signature).decode()


def verify(public_key_bytes: bytes, payload: dict, signature: str) -> bool:
    key = Ed25519PublicKey.from_public_bytes(public_key_bytes)
    sig_bytes = base64.b64decode(signature)
    try:
        key.verify(sig_bytes, _canonical(payload))
        return True
    except InvalidSignature:
        return False
