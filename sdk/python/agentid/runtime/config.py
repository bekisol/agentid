"""
Configuration dataclasses and TOML loader for AgentRuntime.

Supports loading from a TOML file:

    [agent]
    did      = "did:agentid:abc123"
    api_key  = "ak_..."
    base_url = "https://agentid.dev"   # optional

    [runtime]
    poll_timeout = 30     # optional
    concurrency  = 4      # optional
    health_port  = 8080   # optional — starts /health HTTP endpoint
    log_level    = "INFO" # optional

Usage
-----
    from agentid.runtime.config import RuntimeConfig

    cfg = RuntimeConfig.from_toml("agentid.toml")
    runtime = cfg.build_runtime(handler=my_handler)
    asyncio.run(runtime.run_forever())
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


# ── AgentConfig ───────────────────────────────────────────────────────────────


@dataclass
class AgentConfig:
    """Identity and API connection settings for one agent."""

    did: str
    api_key: str
    base_url: str = "https://agentid.dev"


# ── RuntimeConfig ─────────────────────────────────────────────────────────────


@dataclass
class RuntimeConfig:
    """
    Full runtime configuration.

    Attributes
    ----------
    agent : AgentConfig
        Agent identity and connection settings.
    poll_timeout : int
        Seconds per long-poll request (default 30).
    concurrency : int
        Max simultaneous handler coroutines (default 4).
    health_port : int | None
        If set, start an HTTP /health endpoint on this port.
    log_level : str
        Python logging level name (default "INFO").
    """

    agent: AgentConfig
    poll_timeout: int = 30
    concurrency: int = 4
    health_port: Optional[int] = None
    log_level: str = "INFO"

    # ── factories ──────────────────────────────────────────────────────────

    @classmethod
    def from_toml(cls, path: str | Path) -> "RuntimeConfig":
        """
        Load configuration from a TOML file.

        Python 3.11+ uses the stdlib ``tomllib``. Older versions require
        ``pip install tomli``.

        Parameters
        ----------
        path : str | Path
            Path to the TOML config file.

        Returns
        -------
        RuntimeConfig
        """
        try:
            import tomllib  # type: ignore  # stdlib 3.11+
        except ImportError:
            try:
                import tomli as tomllib  # type: ignore
            except ImportError as exc:
                raise ImportError(
                    "tomli is required for TOML config on Python < 3.11. "
                    "Install it with: pip install tomli"
                ) from exc

        p = Path(path)
        if not p.exists():
            raise FileNotFoundError(f"Config file not found: {p}")

        with open(p, "rb") as fh:
            data = tomllib.load(fh)

        agent_data = data.get("agent", {})
        runtime_data = data.get("runtime", {})

        # Environment variables take precedence over file values
        did = os.environ.get("AGENTID_DID") or agent_data.get("did", "")
        api_key = os.environ.get("AGENTID_API_KEY") or agent_data.get("api_key", "")
        base_url = (
            os.environ.get("AGENTID_BASE_URL")
            or agent_data.get("base_url", "https://agentid.dev")
        )

        if not did:
            raise ValueError(
                "Agent DID is required. Set [agent] did in config or AGENTID_DID env var."
            )
        if not api_key:
            raise ValueError(
                "API key is required. Set [agent] api_key in config or AGENTID_API_KEY env var."
            )

        return cls(
            agent=AgentConfig(did=did, api_key=api_key, base_url=base_url),
            poll_timeout=int(runtime_data.get("poll_timeout", 30)),
            concurrency=int(runtime_data.get("concurrency", 4)),
            health_port=runtime_data.get("health_port"),
            log_level=runtime_data.get("log_level", "INFO").upper(),
        )

    @classmethod
    def from_env(cls) -> "RuntimeConfig":
        """
        Load configuration from environment variables only.

        Required env vars:
          AGENTID_DID       — agent DID
          AGENTID_API_KEY   — API key

        Optional:
          AGENTID_BASE_URL      — server URL (default https://agentid.dev)
          AGENTID_POLL_TIMEOUT  — seconds (default 30)
          AGENTID_CONCURRENCY   — int (default 4)
          AGENTID_HEALTH_PORT   — int (if set, starts health endpoint)
          AGENTID_LOG_LEVEL     — INFO/DEBUG/WARNING (default INFO)
        """
        did = os.environ.get("AGENTID_DID", "")
        api_key = os.environ.get("AGENTID_API_KEY", "")
        if not did:
            raise ValueError("AGENTID_DID environment variable is required")
        if not api_key:
            raise ValueError("AGENTID_API_KEY environment variable is required")

        health_raw = os.environ.get("AGENTID_HEALTH_PORT")
        return cls(
            agent=AgentConfig(
                did=did,
                api_key=api_key,
                base_url=os.environ.get("AGENTID_BASE_URL", "https://agentid.dev"),
            ),
            poll_timeout=int(os.environ.get("AGENTID_POLL_TIMEOUT", 30)),
            concurrency=int(os.environ.get("AGENTID_CONCURRENCY", 4)),
            health_port=int(health_raw) if health_raw else None,
            log_level=os.environ.get("AGENTID_LOG_LEVEL", "INFO").upper(),
        )

    # ── build helpers ─────────────────────────────────────────────────────────

    def configure_logging(self) -> None:
        """Apply the configured log level to the root logger."""
        level = getattr(logging, self.log_level, logging.INFO)
        logging.basicConfig(
            level=level,
            format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
        )

    def build_runtime(self, handler) -> "AgentRuntime":  # type: ignore[name-defined]
        """
        Build an :class:`AgentRuntime` from this config.

        Parameters
        ----------
        handler
            Message handler callable.

        Returns
        -------
        AgentRuntime
        """
        from .runtime import AgentRuntime

        return AgentRuntime(
            did=self.agent.did,
            api_key=self.agent.api_key,
            handler=handler,
            base_url=self.agent.base_url,
            poll_timeout=self.poll_timeout,
            concurrency=self.concurrency,
        )
