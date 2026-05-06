"""
Built-in message handlers for common agent patterns.

These are ready-to-use callables that match the Handler signature:
    fn(message: dict, ctx: MessageContext) -> str | None

Examples
--------
    from agentid.runtime import AgentRuntime
    from agentid.runtime.handlers import echo_handler, static_reply, keyword_router

    # Echo everything back
    runtime = AgentRuntime(did=..., api_key=..., handler=echo_handler)

    # Always reply with the same text
    runtime = AgentRuntime(did=..., api_key=..., handler=static_reply("I'm busy, try later."))

    # Route by keyword
    handler = keyword_router(
        ("hello", lambda msg, ctx: "Hi there!"),
        ("help",  lambda msg, ctx: "Commands: hello, help, status"),
        default=lambda msg, ctx: "Unknown command.",
    )
    runtime = AgentRuntime(did=..., api_key=..., handler=handler)
"""

from __future__ import annotations

import logging
from typing import Callable, Optional, Tuple

from .runtime import Handler, MessageContext

logger = logging.getLogger(__name__)


# ── echo ──────────────────────────────────────────────────────────────────────


async def echo_handler(message: dict, ctx: MessageContext) -> str:
    """
    Reply to every message by echoing its body back to the sender.

    Useful for testing that the runtime is wired up correctly.
    """
    body = message.get("body", "")
    return f"Echo: {body}"


# ── static reply ──────────────────────────────────────────────────────────────


def static_reply(text: str) -> Handler:
    """
    Return a handler that always replies with *text*, regardless of input.

    Parameters
    ----------
    text : str
        The fixed reply text.

    Returns
    -------
    Handler
    """

    async def _handler(message: dict, ctx: MessageContext) -> str:
        return text

    _handler.__name__ = f"static_reply({text!r})"
    return _handler


# ── keyword router ────────────────────────────────────────────────────────────

Rule = Tuple[str, Handler]


def keyword_router(
    *rules: Rule,
    default: Optional[Handler] = None,
    case_sensitive: bool = False,
) -> Handler:
    """
    Route messages to different handlers based on keywords in the body.

    Each rule is a ``(keyword, handler)`` tuple. The first matching keyword
    wins (checked in order). Matching is substring-based by default.

    Parameters
    ----------
    *rules : (str, Handler)
        Ordered keyword→handler pairs.
    default : Handler | None
        Fallback handler when no keyword matches. If None, the message is
        silently dropped (handler returns None).
    case_sensitive : bool
        Whether keyword matching is case-sensitive. Default False.

    Returns
    -------
    Handler

    Example
    -------
        handler = keyword_router(
            ("hello", lambda msg, ctx: "Hi!"),
            ("bye",   lambda msg, ctx: "Goodbye!"),
            default=lambda msg, ctx: "I didn't understand that.",
        )
    """
    _rules: list[tuple[str, Handler]] = [
        (kw if case_sensitive else kw.lower(), fn) for kw, fn in rules
    ]

    async def _route(message: dict, ctx: MessageContext) -> Optional[str]:
        body: str = message.get("body", "")
        search = body if case_sensitive else body.lower()

        for keyword, fn in _rules:
            if keyword in search:
                import inspect

                if inspect.iscoroutinefunction(fn):
                    return await fn(message, ctx)
                return fn(message, ctx)

        if default is not None:
            import inspect

            if inspect.iscoroutinefunction(default):
                return await default(message, ctx)
            return default(message, ctx)

        return None

    _route.__name__ = f"keyword_router({[kw for kw, _ in _rules]})"
    return _route


# ── logging passthrough ───────────────────────────────────────────────────────


def logged(handler: Handler, log_level: int = logging.INFO) -> Handler:
    """
    Wrap a handler to log every incoming message before dispatching.

    Parameters
    ----------
    handler : Handler
        The handler to wrap.
    log_level : int
        Python logging level. Default logging.INFO.

    Returns
    -------
    Handler
    """
    import inspect

    async def _logged(message: dict, ctx: MessageContext) -> Optional[str]:
        logger.log(
            log_level,
            "[handler] message id=%s from=%s body=%r",
            message.get("id"),
            message.get("from_did"),
            (message.get("body") or "")[:120],
        )
        if inspect.iscoroutinefunction(handler):
            return await handler(message, ctx)
        return handler(message, ctx)

    _logged.__name__ = f"logged({getattr(handler, '__name__', repr(handler))})"
    return _logged
