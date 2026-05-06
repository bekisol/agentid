"""
Built-in tools for AgentBrain.

Pass tool instances to AgentBrain to give the LLM research capabilities:

    from agentid.brain.tools import WebSearchTool, FetchURLTool

    brain = AgentBrain(
        ...,
        tools=[
            WebSearchTool(api_key="BSA..."),   # Brave Search (recommended)
            FetchURLTool(),
        ],
    )

The LLM autonomously decides when and how to use each tool based on its
mission. No hardcoded data sources — one set of tools covers any domain.

Custom tools
------------
Subclass Tool and implement name, description, parameters, and run():

    from agentid.brain.tools import Tool

    class StockPriceTool(Tool):
        name = "get_stock_price"
        description = "Get the current stock price for a ticker."
        parameters = {
            "type": "object",
            "properties": {
                "ticker": {"type": "string", "description": "e.g. AAPL, BZ=F"}
            },
            "required": ["ticker"],
        }

        async def run(self, ticker: str) -> str:
            price = await fetch_from_your_api(ticker)
            return f"{ticker}: ${price}"
"""

from .base import Tool
from .web_search import WebSearchTool
from .fetch_url import FetchURLTool

__all__ = ["Tool", "WebSearchTool", "FetchURLTool"]
