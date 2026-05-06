"""
CLI entry point for AgentRuntime.

    python3 -m agentid.runtime --config agentid.toml
    python3 -m agentid.runtime --handler mymodule:my_handler

Or via installed script:
    agentid-runtime --config agentid.toml

Modes
-----
  poll (default)   Long-poll the server for new messages. Works everywhere.
  webhook          Receive messages as HTTP POSTs from the server.
                   Requires a public URL (Railway, ngrok, etc.).

Flags
-----
  --config FILE          Path to TOML config file
  --handler MODULE:FN    Import path to the handler, e.g. myapp.bot:handle_message
  --mode poll|webhook    Transport mode (default: poll)
  --webhook-url URL      Public URL the server will POST to (webhook mode only)
  --webhook-port PORT    Local port for the webhook listener (default: 9000)
  --webhook-secret KEY   Optional HMAC secret for signature verification
  --did DID              Agent DID (overrides config/env)
  --api-key KEY          API key (overrides config/env)
  --base-url URL         Server URL (default https://api.agentid-protocol.com)
  --health-port PORT     Start /health HTTP endpoint on this port
  --log-level LEVEL      Logging level (DEBUG/INFO/WARNING, default INFO)
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import logging
import sys

logger = logging.getLogger(__name__)


def _load_handler(spec: str):
    """
    Import a handler from a dotted module:function spec.

    Parameters
    ----------
    spec : str
        Format ``module.path:function_name``.

    Returns
    -------
    callable
    """
    if ":" not in spec:
        print(f"[agentid-runtime] Invalid handler spec {spec!r}. Use module:function.", file=sys.stderr)
        sys.exit(1)
    module_path, fn_name = spec.rsplit(":", 1)
    try:
        module = importlib.import_module(module_path)
    except ImportError as exc:
        print(f"[agentid-runtime] Cannot import {module_path!r}: {exc}", file=sys.stderr)
        sys.exit(1)
    try:
        return getattr(module, fn_name)
    except AttributeError:
        print(f"[agentid-runtime] {module_path!r} has no attribute {fn_name!r}", file=sys.stderr)
        sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="agentid-runtime",
        description="Run an AgentID agent as a persistent message-processing loop.",
    )
    parser.add_argument("--config", metavar="FILE", help="Path to TOML config file")
    parser.add_argument(
        "--handler",
        metavar="MODULE:FN",
        help="Handler import path, e.g. myapp.bot:handle_message. "
             "Defaults to the built-in echo handler.",
    )
    parser.add_argument(
        "--mode",
        choices=["poll", "webhook"],
        default="poll",
        help="Transport mode: 'poll' (default, works everywhere) or "
             "'webhook' (instant, needs a public URL).",
    )
    parser.add_argument(
        "--webhook-url",
        metavar="URL",
        help="Public URL the AgentID server will POST to (webhook mode). "
             "e.g. https://myapp.railway.app/webhook or https://abc.ngrok.io/webhook",
    )
    parser.add_argument(
        "--webhook-port",
        metavar="PORT",
        type=int,
        default=9000,
        help="Local port for the inbound webhook listener (default: 9000).",
    )
    parser.add_argument(
        "--webhook-secret",
        metavar="SECRET",
        default=None,
        help="Optional HMAC-SHA256 secret. When set, signatures on incoming "
             "webhooks are verified and invalid requests are rejected.",
    )
    parser.add_argument("--did", metavar="DID", help="Agent DID (overrides config)")
    parser.add_argument("--api-key", metavar="KEY", help="API key (overrides config)")
    parser.add_argument("--base-url", metavar="URL", default=None)
    parser.add_argument("--health-port", metavar="PORT", type=int, default=None)
    parser.add_argument(
        "--log-level",
        metavar="LEVEL",
        default=None,
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    args = parser.parse_args()

    # ── validate webhook args ─────────────────────────────────────────────────
    if args.mode == "webhook" and not args.webhook_url:
        print(
            "[agentid-runtime] --webhook-url is required in webhook mode.\n"
            "  Example: --webhook-url https://myapp.railway.app/webhook\n"
            "  For local dev: run `ngrok http 9000` and use the https URL it gives you.",
            file=sys.stderr,
        )
        sys.exit(1)

    # ── load config ───────────────────────────────────────────────────────────
    from .config import RuntimeConfig

    try:
        if args.config:
            cfg = RuntimeConfig.from_toml(args.config)
        else:
            cfg = RuntimeConfig.from_env()
    except (FileNotFoundError, ValueError) as exc:
        print(f"[agentid-runtime] Config error: {exc}", file=sys.stderr)
        sys.exit(1)

    # CLI flags override config
    if args.did:
        cfg.agent.did = args.did
    if args.api_key:
        cfg.agent.api_key = args.api_key
    if args.base_url:
        cfg.agent.base_url = args.base_url
    if args.health_port:
        cfg.health_port = args.health_port
    if args.log_level:
        cfg.log_level = args.log_level

    cfg.configure_logging()

    # ── load handler ──────────────────────────────────────────────────────────
    if args.handler:
        handler = _load_handler(args.handler)
    else:
        from .handlers import echo_handler
        handler = echo_handler
        logger.info("[runtime] no --handler specified, using echo_handler")

    # ── build runtime ─────────────────────────────────────────────────────────
    runtime = cfg.build_runtime(handler)

    # ── optional health endpoint ──────────────────────────────────────────────
    if cfg.health_port:
        from .health import start_health_server
        start_health_server(port=cfg.health_port, runtime=runtime)

    # ── run ───────────────────────────────────────────────────────────────────
    try:
        if args.mode == "webhook":
            logger.info("[runtime] mode=webhook port=%d url=%s", args.webhook_port, args.webhook_url)
            asyncio.run(
                runtime.run_webhook(
                    webhook_url=args.webhook_url,
                    port=args.webhook_port,
                    secret=args.webhook_secret,
                )
            )
        else:
            asyncio.run(runtime.run_forever())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
