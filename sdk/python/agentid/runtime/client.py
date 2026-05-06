"""
AsyncAgentIDClient — low-level async HTTP client for the AgentID API.

Handles:
  - x-api-key authentication
  - Message polling (long-poll via since_id)
  - Sending replies
  - Fetching message history
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://agentid.dev"
DEFAULT_POLL_TIMEOUT = 30  # seconds


class AsyncAgentIDClient:
    """
    Async HTTP client for the AgentID messaging API.

    Parameters
    ----------
    api_key : str
        Your AgentID API key (sent as x-api-key header).
    base_url : str
        Base URL of the AgentID server. Defaults to https://agentid.dev.
    poll_timeout : int
        How long (seconds) to wait on each long-poll request.
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        poll_timeout: int = DEFAULT_POLL_TIMEOUT,
    ) -> None:
        if not api_key:
            raise ValueError("api_key must be a non-empty string")
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._poll_timeout = poll_timeout
        self._client: Optional[httpx.AsyncClient] = None

    # ── lifecycle ─────────────────────────────────────────────────────────────

    async def __aenter__(self) -> "AsyncAgentIDClient":
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            headers={
                "x-api-key": self._api_key,
                "content-type": "application/json",
                "accept": "application/json",
            },
            timeout=httpx.Timeout(
                connect=10,
                read=self._poll_timeout + 10,
                write=15,
                pool=10,
            ),
        )
        return self

    async def __aexit__(self, *_: Any) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    def _check_client(self) -> httpx.AsyncClient:
        if self._client is None:
            raise RuntimeError(
                "AsyncAgentIDClient must be used as an async context manager"
            )
        return self._client

    # ── messaging API ─────────────────────────────────────────────────────────

    async def poll_messages(
        self,
        did: str,
        since_id: Optional[int] = None,
        timeout: Optional[int] = None,
    ) -> list[dict]:
        """
        Long-poll for new messages addressed to *did*.

        Parameters
        ----------
        did : str
            The agent DID whose inbox to poll.
        since_id : int | None
            Return only messages with id > since_id. None means all messages.
        timeout : int | None
            Override the default poll_timeout for this call.

        Returns
        -------
        list[dict]
            List of message dicts, ordered ascending by id.
        """
        client = self._check_client()
        params: dict[str, Any] = {"timeout": timeout or self._poll_timeout}
        if since_id is not None:
            params["since_id"] = since_id

        resp = await client.get(f"/agents/{did}/messages/poll", params=params)
        resp.raise_for_status()
        data = resp.json()
        # Server returns {"messages": [...]} or a bare list
        if isinstance(data, list):
            return data
        return data.get("messages", [])

    async def get_messages(
        self,
        did: str,
        limit: int = 20,
        before_id: Optional[int] = None,
    ) -> list[dict]:
        """
        Fetch recent messages (non-polling, instant response).

        Parameters
        ----------
        did : str
            The agent DID whose inbox to query.
        limit : int
            Max number of messages to return.
        before_id : int | None
            Return messages with id < before_id (for pagination).

        Returns
        -------
        list[dict]
        """
        client = self._check_client()
        params: dict[str, Any] = {"limit": limit}
        if before_id is not None:
            params["before_id"] = before_id

        resp = await client.get(f"/agents/{did}/messages", params=params)
        resp.raise_for_status()
        data = resp.json()
        if isinstance(data, list):
            return data
        return data.get("messages", [])

    async def send_message(
        self,
        from_did: str,
        to_did: str,
        body: str,
        content_type: str = "text/plain",
        metadata: Optional[dict] = None,
    ) -> dict:
        """
        Send a message from *from_did* to *to_did*.

        Parameters
        ----------
        from_did : str
            Sender agent DID.
        to_did : str
            Recipient agent DID.
        body : str
            Message text body.
        content_type : str
            MIME type (default text/plain).
        metadata : dict | None
            Optional extra fields included in the request payload.

        Returns
        -------
        dict
            Server response body (typically includes the new message id).
        """
        client = self._check_client()
        payload: dict[str, Any] = {
            "from_did": from_did,
            "to_did": to_did,
            "body": body,
            "content_type": content_type,
        }
        if metadata:
            payload.update(metadata)

        resp = await client.post("/messages", json=payload)
        resp.raise_for_status()
        return resp.json()
