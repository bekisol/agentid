"""
WebSearchTool — search the web for current information.

Primary:  Brave Search API (free tier: 2,000 queries/month)
          Get a free key at https://api.search.brave.com/

Fallback: DuckDuckGo Instant Answer API (no key, topic summaries only)

The LLM uses this to research any domain — oil prices, OPEC news, earnings,
geopolitical events, competitor activity — without pre-built connectors.
"""

from __future__ import annotations

import logging

import httpx

from .base import Tool

logger = logging.getLogger(__name__)


class WebSearchTool(Tool):
    """
    Search the web and return titles, URLs, and descriptions of top results.

    Parameters
    ----------
    api_key : str
        Brave Search API key. If empty, falls back to DuckDuckGo (limited).
    max_results : int
        Default number of results to return. LLM can request 1–10 per call.

    Example
    -------
        # With Brave (recommended)
        WebSearchTool(api_key="BSA...")

        # Without key (fallback, topic summaries only)
        WebSearchTool()
    """

    name = "web_search"
    description = (
        "Search the web for current, real-time information on any topic. "
        "Use this to look up news, prices, events, company data, market conditions, "
        "regulatory changes, or any information you don't already know. "
        "Returns titles, URLs, and descriptions of the top results."
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": (
                    "The search query. Be specific for best results. "
                    "Example: 'Brent crude oil price today' or 'OPEC production cut 2026'"
                ),
            },
            "num_results": {
                "type": "integer",
                "description": "Number of results to return (1–10). Default: 5.",
            },
        },
        "required": ["query"],
    }

    def __init__(self, api_key: str = "", max_results: int = 5) -> None:
        self.api_key = api_key
        self.max_results = max_results

    async def run(self, query: str, num_results: int | None = None) -> str:
        n = min(max(1, num_results or self.max_results), 10)
        if self.api_key:
            try:
                return await self._brave(query, n)
            except Exception as exc:
                logger.warning("[brain/web_search] Brave failed (%s), falling back to DDG", exc)
        return await self._ddg(query, n)

    # ── Brave Search ───────────────────────────────────────────────────────────

    async def _brave(self, query: str, n: int) -> str:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(
                "https://api.search.brave.com/res/v1/web/search",
                headers={
                    "Accept": "application/json",
                    "Accept-Encoding": "gzip",
                    "X-Subscription-Token": self.api_key,
                },
                params={"q": query, "count": n, "text_decorations": "false"},
            )

        if not resp.is_success:
            raise RuntimeError(f"Brave {resp.status_code}: {resp.text[:100]}")

        results = resp.json().get("web", {}).get("results", [])
        if not results:
            return f"No results found for: {query}"

        lines = [f"Search: {query}\n"]
        for i, r in enumerate(results[:n], 1):
            lines.append(
                f"{i}. {r.get('title', 'No title')}\n"
                f"   {r.get('url', '')}\n"
                f"   {r.get('description', '').strip()}\n"
            )
        return "\n".join(lines)

    # ── DuckDuckGo fallback ────────────────────────────────────────────────────

    async def _ddg(self, query: str, n: int) -> str:
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(
                    "https://api.duckduckgo.com/",
                    params={
                        "q": query,
                        "format": "json",
                        "no_html": "1",
                        "skip_disambig": "1",
                    },
                    headers={
                        "User-Agent": "agentid-brain/0.3 (+https://agentid-protocol.com)"
                    },
                )
            data = resp.json()
        except Exception as exc:
            return f"Search unavailable for: {query} ({exc})"

        parts: list[str] = []

        abstract = (data.get("Abstract") or "").strip()
        if abstract:
            parts.append(f"Summary: {abstract}")
            if data.get("AbstractURL"):
                parts.append(f"Source: {data['AbstractURL']}")

        answer = (data.get("Answer") or "").strip()
        if answer:
            parts.append(f"Answer: {answer}")

        topics = data.get("RelatedTopics", [])
        if topics:
            parts.append(f"\nRelated results for '{query}':")
            for t in topics[:n]:
                if isinstance(t, dict) and t.get("Text"):
                    text = t["Text"][:150]
                    url = t.get("FirstURL", "")
                    parts.append(f"  • {text}")
                    if url:
                        parts.append(f"    {url}")

        if not parts:
            return (
                f"Limited results for: '{query}'.\n"
                f"For full web search, provide a Brave Search API key "
                f"(free at https://api.search.brave.com/) to WebSearchTool."
            )

        return "\n".join(parts)
