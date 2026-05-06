"""
APIPerception — poll an HTTP endpoint and detect response changes.

Useful for watching:
  - Internal dashboards / metrics APIs
  - Public data feeds
  - Health check endpoints
  - Any JSON/text API

Example
-------
    from agentid.brain.perception.api import APIPerception

    brain.add_perception(APIPerception(
        url="https://api.example.com/metrics",
        headers={"Authorization": "Bearer sk-..."},
        extract="$.errors",   # simple dotpath extraction (optional)
    ))
"""

from __future__ import annotations

import hashlib
import json
from typing import Optional

import httpx

from .base import Perception, PerceptionData


def _checksum(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def _extract(data: dict | list, path: str) -> str:
    """
    Minimal dotpath extraction: "$.key.subkey" or "$.0.name".
    Returns JSON string of the extracted value, or the full data if path fails.
    """
    if not path or not path.startswith("$"):
        return json.dumps(data, indent=2)
    parts = path.lstrip("$.").split(".")
    node = data
    for part in parts:
        try:
            node = node[int(part)] if part.isdigit() else node[part]
        except (KeyError, IndexError, TypeError):
            return json.dumps(data, indent=2)
    return json.dumps(node, indent=2) if isinstance(node, (dict, list)) else str(node)


class APIPerception(Perception):
    """
    Poll an HTTP API endpoint and detect changes in the response.

    Parameters
    ----------
    url : str
        The endpoint to poll.
    method : str
        HTTP method. Default "GET".
    headers : dict | None
        Extra headers (e.g. Authorization).
    body : dict | None
        Request body for POST/PUT.
    extract : str | None
        Simple dotpath to extract a sub-field from JSON response
        (e.g. "$.data.status"). None = use full response.
    timeout : int
        Request timeout in seconds. Default 15.
    name : str | None
        Override the source name.
    """

    def __init__(
        self,
        url: str,
        method: str = "GET",
        headers: Optional[dict] = None,
        body: Optional[dict] = None,
        extract: Optional[str] = None,
        timeout: int = 15,
        name: Optional[str] = None,
    ) -> None:
        self._url = url
        self._method = method.upper()
        self._headers = headers or {}
        self._body = body
        self._extract = extract
        self._timeout = timeout
        # Derive a short name from the URL
        from urllib.parse import urlparse
        parsed = urlparse(url)
        short = parsed.netloc + parsed.path.rstrip("/")
        super().__init__(name=name or f"api:{short[:40]}")

    async def read(self, last_state: Optional[str] = None) -> PerceptionData:
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.request(
                    self._method,
                    self._url,
                    headers=self._headers,
                    json=self._body,
                )
            resp.raise_for_status()

            # Try JSON parse, fallback to text
            try:
                data = resp.json()
                text = _extract(data, self._extract or "") if self._extract else json.dumps(data, indent=2)
            except Exception:
                text = resp.text[:4000]

        except Exception as exc:
            return PerceptionData(
                source=self.name,
                content=f"API error for {self._url}: {exc}",
                changed=False,
                state_token="error",
                metadata={"url": self._url, "error": str(exc)},
            )

        token = _checksum(text)
        changed = last_state is not None and last_state != token

        prefix = f"API response from {self._url}"
        if changed:
            prefix += " — CHANGED since last check"
        prefix += ":\n\n"

        return PerceptionData(
            source=self.name,
            content=prefix + text[:4000],
            changed=changed,
            state_token=token,
            metadata={"url": self._url, "status": resp.status_code},
        )
