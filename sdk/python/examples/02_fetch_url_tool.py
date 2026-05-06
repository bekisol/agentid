"""
Test 2 — FetchURLTool
=====================
What it does: fetches any URL and returns readable text.
Handles HTML (strips tags), JSON, RSS/XML, plain text.
Truncates long pages so the LLM doesn't get flooded.

Run:
    python3 examples/02_fetch_url_tool.py

What you should see: the readable text content of the BBC News homepage.
"""

import asyncio
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agentid.brain.tools import FetchURLTool


async def main():
    tool = FetchURLTool()

    print("Fetching: https://feeds.bbci.co.uk/news/rss.xml  (BBC RSS feed)\n")
    result = await tool.run(url="https://feeds.bbci.co.uk/news/rss.xml")
    print(result[:2000])  # show first 2000 chars


asyncio.run(main())
