"""
WebhookServer — inbound HTTP server that receives AgentID push events.

The AgentID server sends a POST request to your URL every time a message
arrives. This module:

  1. Starts a lightweight HTTP listener on a local port.
  2. Verifies the HMAC-SHA256 signature (if a secret was configured).
  3. Enqueues the parsed message into an asyncio queue.
  4. Registers (and on shutdown, removes) the webhook URL with the server.

Webhook payload from the server
--------------------------------
    {
      "event":     "message.received",
      "agent_did": "did:agentid:...",
      "message": {
        "id":       123,
        "from_did": "did:agentid:sender",
        "subject":  null,
        "body":     "Hello",
        "sent_at":  "2026-05-06T18:00:00"
      }
    }

Signature header (when secret is set)
--------------------------------------
    X-AgentID-Signature: sha256=<hmac-hex>
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from .runtime import AgentRuntime

logger = logging.getLogger(__name__)

_WEBHOOK_PATHS = {"/webhook", "/webhooks", "/"}


class WebhookServer:
    """
    Runs a background HTTP server that receives webhook POSTs from AgentID
    and feeds them into an asyncio queue for the runtime to dispatch.

    Parameters
    ----------
    port : int
        Local port to listen on (e.g. 9000).
    runtime : AgentRuntime
        The runtime whose handler will process each incoming message.
    secret : str | None
        If set, the HMAC-SHA256 signature on every request is verified.
        Requests with a bad/missing signature are rejected with 401.
    """

    def __init__(
        self,
        port: int,
        runtime: "AgentRuntime",
        secret: Optional[str] = None,
    ) -> None:
        self.port = port
        self.runtime = runtime
        self.secret = secret
        self._queue: Optional[asyncio.Queue] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._server: Optional[HTTPServer] = None
        self._thread: Optional[threading.Thread] = None

    # ── HTTP server (runs in a background thread) ─────────────────────────────

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        """Start the HTTP listener. Must be called with the running event loop."""
        self._loop = loop
        self._queue = asyncio.Queue()

        _self = self  # capture for closure

        class _Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                path = self.path.split("?")[0].rstrip("/") or "/"
                if path not in _WEBHOOK_PATHS:
                    self._respond(404, b'{"error":"not found"}')
                    return

                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length)

                # ── HMAC verification ─────────────────────────────────────────
                if _self.secret:
                    sig_header = self.headers.get("X-AgentID-Signature", "")
                    expected = (
                        "sha256="
                        + hmac.new(
                            _self.secret.encode(), body, hashlib.sha256
                        ).hexdigest()
                    )
                    if not hmac.compare_digest(sig_header, expected):
                        logger.warning("[webhook] bad signature — rejected")
                        self._respond(401, b'{"error":"invalid signature"}')
                        return

                # ── parse + enqueue ───────────────────────────────────────────
                try:
                    data = json.loads(body)
                except json.JSONDecodeError:
                    self._respond(400, b'{"error":"invalid json"}')
                    return

                # Unwrap the envelope if present
                msg = data.get("message") or data
                asyncio.run_coroutine_threadsafe(
                    _self._queue.put(msg), _self._loop  # type: ignore[arg-type]
                )
                self._respond(200, b'{"ok":true}')

            def _respond(self, status: int, body: bytes) -> None:
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, fmt: str, *args: object) -> None:  # noqa: D102
                logger.debug("[webhook-http] %s", fmt % args)

        self._server = HTTPServer(("0.0.0.0", self.port), _Handler)
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            daemon=True,
            name="agentid-webhook",
        )
        self._thread.start()
        logger.info("[webhook] listening on :%d → POST /webhook", self.port)

    def stop(self) -> None:
        """Shut down the HTTP server gracefully."""
        if self._server:
            self._server.shutdown()

    # ── asyncio drain loop ────────────────────────────────────────────────────

    async def drain_forever(self, stop_event: asyncio.Event) -> None:
        """
        Pull messages off the queue and dispatch them to the runtime handler.
        Runs until *stop_event* is set and the queue is empty.
        """
        assert self._queue is not None
        while not stop_event.is_set() or not self._queue.empty():
            try:
                msg = await asyncio.wait_for(self._queue.get(), timeout=1.0)
                asyncio.create_task(self.runtime._dispatch(msg))
            except asyncio.TimeoutError:
                continue


# ── registration helpers ──────────────────────────────────────────────────────


async def register_webhook(
    client,  # AsyncAgentIDClient
    did: str,
    url: str,
    secret: Optional[str] = None,
) -> dict:
    """
    Register *url* as the webhook endpoint for *did*.

    POST /agents/{did}/webhook  {"url": "...", "secret": "..."}
    """
    payload: dict = {"url": url}
    if secret:
        payload["secret"] = secret
    http = client._check_client()
    resp = await http.post(f"/agents/{did}/webhook", json=payload)
    resp.raise_for_status()
    result = resp.json()
    logger.info("[webhook] registered — did=%s url=%s", did, url)
    return result


async def deregister_webhook(client, did: str) -> dict:
    """
    Remove the registered webhook for *did*.

    DELETE /agents/{did}/webhook
    """
    http = client._check_client()
    resp = await http.delete(f"/agents/{did}/webhook")
    resp.raise_for_status()
    logger.info("[webhook] deregistered — did=%s", did)
    return resp.json()
