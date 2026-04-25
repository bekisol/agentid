"""Verification utilities for AgentID-signed AutoGen messages."""

from __future__ import annotations

import json
import logging
from typing import Optional

logger = logging.getLogger(__name__)

_SEPARATOR = "\n\n---agentid---\n"


def extract_signed_payload(content: str) -> tuple[str, dict | None]:
    """
    Split an AgentID message into (clean_content, signed_envelope).

    Returns (content, None) if the message has no AgentID signature.

    Usage::

        content, envelope = extract_signed_payload(message["content"])
        if envelope:
            print(f"Signed by: {envelope['did']}")

    """
    if _SEPARATOR not in content:
        return content, None

    parts = content.split(_SEPARATOR, 1)
    clean = parts[0]
    try:
        envelope = json.loads(parts[1])
    except (json.JSONDecodeError, IndexError):
        logger.warning("[AgentID] Malformed signature envelope in message")
        return clean, None

    return clean, envelope


def verify_autogen_message(
    content: str,
    registry_url: Optional[str] = None,
    registry_path: Optional[str] = None,
) -> bool:
    """
    Verify an AgentID-signed AutoGen message.

    Args:
        content: The raw message content string (may contain signature envelope).
        registry_url: Remote registry URL to resolve the signer's DID.
        registry_path: Local registry path to resolve the signer's DID.

    Returns:
        True if signature is present and valid.
        False if signature is missing or invalid.

    Usage::

        from autogen_agentid import verify_autogen_message

        last_msg = chat_history[-1]["content"]
        if verify_autogen_message(last_msg):
            print("Message is authentic")
        else:
            print("Warning: unverified message")

    """
    from agentid import Agent

    _, envelope = extract_signed_payload(content)

    if envelope is None:
        logger.debug("[AgentID] No signature found in message")
        return False

    try:
        signed_message = {
            "payload": envelope.get("payload", {}),
            "signature": envelope.get("signature", ""),
        }
        return Agent.verify_from_did(
            signed_message,
            registry_url=registry_url,
            registry_path=registry_path,
        )
    except Exception as e:
        logger.warning("[AgentID] Verification error: %s", e)
        return False


def strip_signature(content: str) -> str:
    """Return message content with the AgentID envelope removed.

    Useful when passing messages to an LLM that shouldn't see the raw signature.

    Usage::

        clean = strip_signature(message["content"])

    """
    clean, _ = extract_signed_payload(content)
    return clean
