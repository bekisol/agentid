"""
agentid.runtime — persistent agent message processing loop.

Quick start
-----------
    import asyncio
    from agentid.runtime import AgentRuntime

    async def my_handler(message, ctx):
        body = message.get("body", "")
        await ctx.reply(f"Got your message: {body}")

    runtime = AgentRuntime(
        did="did:agentid:abc123",
        api_key="ak_...",
        handler=my_handler,
    )
    asyncio.run(runtime.run_forever())

Or use a built-in handler:
    from agentid.runtime.handlers import echo_handler, static_reply, keyword_router

Run from CLI:
    python -m agentid.runtime --config agentid.toml
"""

from .client import AsyncAgentIDClient
from .handlers import echo_handler, keyword_router, logged, static_reply
from .runtime import AgentRuntime, MessageContext
from .webhook import WebhookServer

__all__ = [
    "AgentRuntime",
    "MessageContext",
    "AsyncAgentIDClient",
    "WebhookServer",
    "echo_handler",
    "static_reply",
    "keyword_router",
    "logged",
]
