"""
FetchURLTool — fetch and read any URL.

Used by the LLM to read the full content of a news article, an API
response, a data feed, or any webpage after a web_search returns the URL.

Automatically strips HTML boilerplate (nav, scripts, ads) and returns
clean, readable text for the LLM.
"""

from __future__ import annotations

import html
import logging
import re
from html.parser import HTMLParser

import httpx

from .base import Tool

logger = logging.getLogger(__name__)


# ── HTML text extraction ───────────────────────────────────────────────────────


class _Extractor(HTMLParser):
    """Minimal HTML parser — extracts body text, skips scripts/styles."""

    _SKIP = {"script", "style", "head", "noscript", "nav", "footer",
              "iframe", "aside", "header", "menu"}

    def __init__(self) -> None:
        super().__init__()
        self._parts: list[str] = []
        self._depth = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in self._SKIP:
            self._depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in self._SKIP and self._depth > 0:
            self._depth -= 1

    def handle_data(self, data: str) -> None:
        if self._depth == 0:
            s = data.strip()
            if s:
                self._parts.append(s)

    def text(self) -> str:
        return " ".join(self._parts)


def _html_to_text(raw: str) -> str:
    parser = _Extractor()
    try:
        parser.feed(raw)
        text = parser.text()
    except Exception:
        text = re.sub(r"<[^>]+>", " ", raw)
    text = html.unescape(text)
    # Collapse excessive whitespace
    text = re.sub(r"\s{3,}", "\n\n", text)
    return text.strip()


# ── Tool ───────────────────────────────────────────────────────────────────────


class FetchURLTool(Tool):
    """
    Fetch the content of any URL and return readable text.

    Use after web_search to read the full article behind a search result.
    Also useful for:
      - Financial data APIs returning JSON (e.g. Yahoo Finance, Alpha Vantage)
      - News RSS feeds
      - Government data portals
      - Any publicly accessible page

    Parameters
    ----------
    max_chars : int
        Maximum characters to return. Default: 6000.
    timeout : int
        Request timeout in seconds. Default: 20.
    """

    name = "fetch_url"
    description = (
        "Fetch and read the full content of any URL. "
        "Use this after web_search to read the complete article or data behind a result. "
        "Works with HTML pages, JSON APIs, RSS feeds, and plain-text documents. "
        "HTML is automatically stripped to readable text."
    )
    parameters = {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "The full URL to fetch (must start with http:// or https://).",
            },
            "max_chars": {
                "type": "integer",
                "description": "Maximum characters to return. Default: 6000.",
            },
        },
        "required": ["url"],
    }

    _HEADERS = {
        "User-Agent": (
            "Mozilla/5.0 (compatible; agentid-brain/0.3; "
            "+https://agentid-protocol.com)"
        ),
        "Accept": "text/html,application/json,application/xml,*/*",
        "Accept-Language": "en-US,en;q=0.9",
    }

    def __init__(self, max_chars: int = 6000, timeout: int = 20) -> None:
        self._max_chars = max_chars
        self._timeout = timeout

    async def run(self, url: str, max_chars: int | None = None) -> str:
        limit = max_chars or self._max_chars

        if not url.startswith(("http://", "https://")):
            return f"Invalid URL: must start with http:// or https:// — got: {url!r}"

        try:
            async with httpx.AsyncClient(
                timeout=self._timeout,
                follow_redirects=True,
                headers=self._HEADERS,
            ) as client:
                resp = await client.get(url)

            if not resp.is_success:
                return f"HTTP {resp.status_code} from {url}"

            ct = resp.headers.get("content-type", "")

            if "json" in ct:
                text = resp.text  # JSON is already readable
            elif "xml" in ct or "rss" in ct or "atom" in ct:
                # Strip XML tags for readability
                text = re.sub(r"<[^>]+>", " ", resp.text)
                text = html.unescape(text)
                text = re.sub(r"\s{3,}", "\n", text).strip()
            elif "html" in ct or "text" in ct or not ct:
                text = _html_to_text(resp.text)
            else:
                return f"[Binary/unsupported content-type: {ct}] at {url}"

            if not text:
                return f"No readable content at {url}"

            if len(text) > limit:
                text = text[:limit] + f"\n\n[… truncated at {limit} chars. Use max_chars to see more.]"

            return text

        except httpx.TimeoutException:
            return f"Timeout fetching {url} (limit: {self._timeout}s)"
        except httpx.TooManyRedirects:
            return f"Too many redirects at {url}"
        except Exception as exc:
            logger.warning("[brain/fetch_url] error at %s: %s", url, exc)
            return f"Error fetching {url}: {exc}"
