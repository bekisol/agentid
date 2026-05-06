"""
AgentRuntime — persistent message loop for AgentID agents.

Usage
-----
    import asyncio
    from agentid.runtime import AgentRuntime

    async def my_handler(message, ctx):
        await ctx.reply(f"Echo: {message['body']}")

    runtime = AgentRuntime(
        did="did:agentid:abc123",
        api_key="ak_...",
        handler=my_handler,
    )
    asyncio.run(runtime.run_forever())
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import signal
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Coroutine, Optional, Union

from .client import AsyncAgentIDClient

logger = logging.getLogger(__name__)

# Where we persist the last-seen message id between restarts
CURSOR_DIR = Path.home() / ".agentid" / "cursors"

# Backoff config (seconds)
_BACKOFF_BASE = 1.0
_BACKOFF_MAX = 60.0


# ── MessageContext ─────────────────────────────────────────────────────────────


@dataclass
class MessageContext:
    """
    Passed to every handler call alongside the raw message dict.

    Provides:
      - reply()          — send a message back to the original sender
      - fetch_history()  — load recent inbox messages for the agent
      - metrics          — timing and attempt metadata for this dispatch
    """

    message: dict
    agent_did: str
    _client: AsyncAgentIDClient
    _runtime: "AgentRuntime"
    _dispatch_start: float = field(default_factory=time.monotonic)

    async def reply(
        self,
        text: str,
        content_type: str = "text/plain",
    ) -> dict:
        """
        Send *text* back to whoever sent the current message.

        Parameters
        ----------
        text : str
            The reply body.
        content_type : str
            MIME type. Default is text/plain.

        Returns
        -------
        dict
            Server response from POST /messages.
        """
        sender = self.message.get("from_did") or self.message.get("sender")
        if not sender:
            raise ValueError("Cannot reply: message has no from_did/sender field")
        return await self._client.send_message(
            from_did=self.agent_did,
            to_did=sender,
            body=text,
            content_type=content_type,
        )

    async def fetch_history(self, limit: int = 20) -> list[dict]:
        """
        Fetch the *limit* most recent messages in this agent's inbox.

        Returns
        -------
        list[dict]
            Messages in descending order (newest first).
        """
        return await self._client.get_messages(self.agent_did, limit=limit)

    @property
    def metrics(self) -> dict:
        """Timing metadata for the current dispatch."""
        return {
            "message_id": self.message.get("id"),
            "elapsed_ms": round((time.monotonic() - self._dispatch_start) * 1000),
            "agent_did": self.agent_did,
            "total_processed": self._runtime.messages_processed,
        }


# ── handler type ──────────────────────────────────────────────────────────────

Handler = Callable[
    [dict, MessageContext],
    Union[Optional[str], Coroutine[Any, Any, Optional[str]]],
]


# ── AgentRuntime ──────────────────────────────────────────────────────────────


class AgentRuntime:
    """
    Persistent polling loop that processes messages for one agent DID.

    Parameters
    ----------
    did : str
        The agent DID to poll messages for.
    api_key : str
        AgentID API key (x-api-key header).
    handler : Handler
        Async or sync callable: ``fn(message, ctx) -> str | None``.
        Return a string to auto-reply, return None to suppress auto-reply.
    base_url : str
        AgentID server URL. Defaults to https://agentid.dev.
    poll_timeout : int
        Seconds per long-poll request. Default 30.
    concurrency : int
        Max simultaneous handler coroutines. Default 4.
    """

    def __init__(
        self,
        did: str,
        api_key: str,
        handler: Handler,
        base_url: str = "https://agentid.dev",
        poll_timeout: int = 30,
        concurrency: int = 4,
    ) -> None:
        self.did = did
        self.handler = handler
        self.messages_processed: int = 0
        self._stop_event = asyncio.Event()
        self._semaphore: Optional[asyncio.Semaphore] = None
        self._client = AsyncAgentIDClient(
            api_key=api_key,
            base_url=base_url,
            poll_timeout=poll_timeout,
        )
        self._concurrency = concurrency
        self._since_id: Optional[int] = self._load_cursor()

    # ── cursor persistence ────────────────────────────────────────────────────

    def _cursor_path(self) -> Path:
        safe = self.did.replace(":", "_").replace("/", "_")
        return CURSOR_DIR / f"{safe}.cursor"

    def _load_cursor(self) -> Optional[int]:
        CURSOR_DIR.mkdir(parents=True, exist_ok=True)
        p = self._cursor_path()
        if p.exists():
            try:
                return int(p.read_text().strip())
            except (ValueError, OSError):
                pass
        return None

    def _save_cursor(self, msg_id: int) -> None:
        try:
            self._cursor_path().write_text(str(msg_id))
        except OSError as exc:
            logger.warning("[runtime] failed to save cursor: %s", exc)

    # ── dispatch ──────────────────────────────────────────────────────────────

    async def _dispatch(self, message: dict) -> None:
        """Call the user handler and auto-reply if it returns a string."""
        ctx = MessageContext(
            message=message,
            agent_did=self.did,
            _client=self._client,
            _runtime=self,
        )
        try:
            if inspect.iscoroutinefunction(self.handler):
                result = await self.handler(message, ctx)
            else:
                loop = asyncio.get_event_loop()
                result = await loop.run_in_executor(None, self.handler, message, ctx)

            if isinstance(result, str) and result.strip():
                await ctx.reply(result)

        except Exception as exc:
            logger.exception(
                "[runtime] handler raised for message %s: %s",
                message.get("id"),
                exc,
            )
        finally:
            self.messages_processed += 1

    # ── poll loop ─────────────────────────────────────────────────────────────

    async def _poll_loop(self) -> None:
        backoff = _BACKOFF_BASE
        async with self._client:
            while not self._stop_event.is_set():
                try:
                    messages = await self._client.poll_messages(
                        self.did, since_id=self._since_id
                    )
                    backoff = _BACKOFF_BASE  # reset on success

                    tasks = []
                    for msg in messages:
                        msg_id = msg.get("id")
                        if msg_id and (
                            self._since_id is None or msg_id > self._since_id
                        ):
                            self._since_id = msg_id
                            self._save_cursor(msg_id)

                        async with self._semaphore:
                            task = asyncio.create_task(self._dispatch(msg))
                            tasks.append(task)

                    if tasks:
                        await asyncio.gather(*tasks, return_exceptions=True)

                except asyncio.CancelledError:
                    break
                except Exception as exc:
                    logger.error(
                        "[runtime] poll error (retry in %.1fs): %s", backoff, exc
                    )
                    try:
                        await asyncio.wait_for(
                            self._stop_event.wait(), timeout=backoff
                        )
                    except asyncio.TimeoutError:
                        pass
                    backoff = min(backoff * 2, _BACKOFF_MAX)

    # ── public API ────────────────────────────────────────────────────────────

    def stop(self) -> None:
        """Signal the runtime to stop after the current poll completes."""
        self._stop_event.set()

    async def run_forever(self) -> None:
        """
        Start the polling loop and block until stopped.

        Installs SIGINT/SIGTERM handlers so Ctrl-C or ``kill`` shuts down
        cleanly. Safe to run directly with ``asyncio.run(runtime.run_forever())``.
        """
        self._semaphore = asyncio.Semaphore(self._concurrency)
        loop = asyncio.get_event_loop()

        def _handle_signal() -> None:
            logger.info("[runtime] shutdown signal received — stopping")
            self.stop()

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, _handle_signal)
            except (NotImplementedError, RuntimeError):
                # add_signal_handler not available on Windows or in threads
                pass

        logger.info(
            "[runtime] starting — did=%s since_id=%s", self.did, self._since_id
        )
        try:
            await self._poll_loop()
        finally:
            logger.info(
                "[runtime] stopped — processed %d messages", self.messages_processed
            )
