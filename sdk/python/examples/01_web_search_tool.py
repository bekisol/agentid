"""
Test 1 — WebSearchTool
======================
What it does: searches the web for current information.
  • With a Brave API key → real search results (title, URL, description)
  • Without a key        → DuckDuckGo fallback (topic summaries)

Run:
    cd /Users/bereket/Documents/agentid/sdk/python
    python3 examples/01_web_search_tool.py

What you should see: 3-5 search results with titles and URLs.
"""

import asyncio
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agentid.brain.tools import WebSearchTool


async def main():
    # No key = DuckDuckGo fallback (always works, no sign-up needed)
    # To use Brave: WebSearchTool(api_key="BSA_YOUR_KEY_HERE")
    tool = WebSearchTool()

    print("Searching for: 'Brent crude oil price today'\n")
    result = await tool.run(query="Brent crude oil price today")
    print(result)


asyncio.run(main())
