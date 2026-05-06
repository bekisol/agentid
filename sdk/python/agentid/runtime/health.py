"""
Minimal stdlib HTTP /health endpoint for AgentRuntime.

Runs on a background daemon thread — no external dependencies required.

The endpoint returns JSON:

    GET /health  →  200 {"status": "ok", "did": "...", "processed": 42}

Usage (called automatically by __main__.py when health_port is configured)
--------------------------------------------------------------------------
    from agentid.runtime.health import start_health_server

    server = start_health_server(port=8080, runtime=my_runtime)
    # server is a threading.Thread — daemon, runs until process exits
"""

from __future__ import annotations

import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .runtime import AgentRuntime

logger = logging.getLogger(__name__)


def start_health_server(port: int, runtime: "AgentRuntime") -> threading.Thread:
    """
    Start a lightweight HTTP server on *port* that serves /health.

    Parameters
    ----------
    port : int
        TCP port to listen on.
    runtime : AgentRuntime
        The runtime instance to report stats from.

    Returns
    -------
    threading.Thread
        The daemon thread running the server.
    """

    class _Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            if self.path.rstrip("/") in ("/health", "/healthz", ""):
                body = json.dumps(
                    {
                        "status": "ok",
                        "did": runtime.did,
                        "processed": runtime.messages_processed,
                    }
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_response(404)
                self.end_headers()

        def log_message(self, fmt: str, *args: object) -> None:  # noqa: D102
            # Suppress default access logs — use our logger instead
            logger.debug("[health] %s", fmt % args)

    server = HTTPServer(("0.0.0.0", port), _Handler)

    def _serve() -> None:
        logger.info("[health] listening on :%d", port)
        server.serve_forever()

    thread = threading.Thread(target=_serve, daemon=True, name="agentid-health")
    thread.start()
    return thread
