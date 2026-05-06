"""
WebSearchTool — search the web for current information.

Provider priority
-----------------
1. Tavily  (api_key starts with "tvly-")  — purpose-built for AI agents.
           Returns a direct answer + clean extracted content per source.
           Free tier: 1,000 queries/month. $1/1,000 after that.
           Get a key at https://app.tavily.com/

2. Brave   (any other non-empty api_key)  — independent search index.
           Free tier: 2,000 queries/month. $3/1,000 after that.
           Get a key at https://api.search.brave.com/

3. DuckDuckGo (no key)                   — free fallback, topic summaries only.

Recommended: pass no api_key and use the platform's built-in search MCP
endpoint (POST /mcp/search) via MCPSession.http() — zero setup for users.
"""

from __future__ import annotations

import logging

import httpx

from .base import Tool

logger = logging.getLogger(__name__)


class WebSearchTool(Tool):
    """
    Search the web and return current results.

    Automatically selects Tavily, Brave, or DuckDuckGo based on the key format.

    Parameters
    ----------
    api_key : str
        Tavily key (tvly-...) or Brave key (BSA-...).
        Leave empty to use DuckDuckGo fallback.
    max_results : int
        Default number of results. LLM can request 1–10 per call.
    """

    name = "web_search"
    description = (
        "Search the web for current, real-time information on any topic. "
        "Use this to look up news, prices, events, company data, market "
        "conditions, regulatory changes, or any information you don't already "
        "know. Returns a direct answer plus the top sources with clean content."
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
                if self.api_key.startswith("tvly-"):
                    return await self._tavily(query, n)
                else:
                    return await self._brave(query, n)
            except Exception as exc:
                logger.warning("[brain/web_search] Search failed (%s), falling back to DDG", exc)

        return await self._ddg(query, n)

    # ── Tavily (recommended for AI agents) ────────────────────────────────────

    async def _tavily(self, query: str, n: int) -> str:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(
                "https://api.tavily.com/search",
                json={
                    "api_key":             self.api_key,
                    "query":               query,
                    "max_results":         n,
                    "search_depth":        "basic",
                    "include_answer":      True,
                    "include_raw_content": False,
                    "include_images":      False,
                },
            )

        if not resp.is_success:
            raise RuntimeError(f"Tavily {resp.status_code}: {resp.text[:100]}")

        data    = resp.json()
        answer  = data.get("answer", "")
        results = data.get("results", [])

        if not results and not answer:
            return f"No results found for: {query}"

        lines = [f"Search: {query}\n"]
        if answer:
            lines.append(f"Answer: {answer}\n")
        if results:
            lines.append("Sources:")
            for r in results:
                title   = r.get("title", "")
                url     = r.get("url", "")
                content = r.get("content", "")[:300]
                score   = r.get("score", 0)
                lines.append(f"\n• {title} (relevance {score:.2f})\n  {url}\n  {content}")

        return "\n".join(lines)

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
                    headers={"User-Agent": "agentid-brain/0.5 (+https://agentid-protocol.com)"},
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
                    url  = t.get("FirstURL", "")
                    parts.append(f"  • {text}")
                    if url:
                        parts.append(f"    {url}")

        if not parts:
            return (
                f"Limited results for: '{query}'.\n"
                f"For full web search, use WebSearchTool(api_key='tvly-...') "
                f"with a Tavily key (free at https://app.tavily.com/)."
            )

        return "\n".join(parts)
