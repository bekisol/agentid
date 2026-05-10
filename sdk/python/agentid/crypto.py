import base64
import json

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey, Ed25519PublicKey
)
from cryptography.exceptions import InvalidSignature

# ── Crypto-agility envelope ────────────────────────────────────────────────────
#
# All new signed objects carry an envelope around the bare base64 signature:
#
#   {
#     "algSuite": "ed25519-sha512-2024",   # algorithm identifier
#     "version":  1,                        # envelope format version
#     "params":   {},                       # reserved for future use (e.g. key ID)
#     "signature": "<base64-std>"           # Ed25519 sig over canonical payload
#   }
#
# This is a forward-only change: the `verify()` function accepts BOTH old bare
# strings (backward-compat for 90 days) and new envelope dicts. When all
# integrated systems have upgraded, the bare-string path can be removed.

_ALG_SUITE   = "ed25519-sha512-2024"
_ENV_VERSION = 1


def _canonical(payload: dict) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()


def sign(private_key_bytes: bytes, payload: dict) -> dict:
    """
    Sign ``payload`` with ``private_key_bytes`` and return a crypto-agility envelope.

    Returns::

        {
            "algSuite": "ed25519-sha512-2024",
            "version":  1,
            "params":   {},
            "signature": "<base64>"
        }
    """
    key = Ed25519PrivateKey.from_private_bytes(private_key_bytes)
    sig_bytes = key.sign(_canonical(payload))
    return {
        "algSuite":  _ALG_SUITE,
        "version":   _ENV_VERSION,
        "params":    {},
        "signature": base64.b64encode(sig_bytes).decode(),
    }


def verify(public_key_bytes: bytes, payload: dict, signature) -> bool:
    """
    Verify a signature over ``payload``.

    ``signature`` may be:
    - A **dict** (new envelope format): ``{"algSuite": ..., "version": ..., "signature": ...}``
    - A **str** (legacy bare base64): accepted for 90-day backward compatibility.

    Returns True if valid, False otherwise.
    """
    try:
        key = Ed25519PublicKey.from_public_bytes(public_key_bytes)

        # Resolve signature bytes from either envelope or legacy bare string
        if isinstance(signature, dict):
            sig_b64 = signature.get("signature", "")
        elif isinstance(signature, str):
            sig_b64 = signature
        else:
            return False

        sig_bytes = base64.b64decode(sig_b64)
        key.verify(sig_bytes, _canonical(payload))
        return True
    except InvalidSignature:
        return False
    except Exception:
        return False
