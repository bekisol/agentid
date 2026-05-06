"""
Tool — abstract base for all brain tools.

A Tool is a function the LLM can call during its reasoning cycle.
Implement name, description, parameters (JSON Schema), and run().

The judgment engine automatically formats tools for each provider's
native function-calling format — you write the tool once.
"""

from __future__ import annotations

from abc import ABC, abstractmethod


class Tool(ABC):
    """
    Abstract base for all AgentBrain tools.

    Class attributes
    ----------------
    name : str
        Tool identifier used by the LLM (no spaces, underscores OK).
    description : str
        What the tool does. The LLM reads this to decide when to call it.
        Be specific — a good description prevents misuse.
    parameters : dict
        JSON Schema describing the tool's input arguments.

    Example
    -------
        class MyTool(Tool):
            name = "get_stock_price"
            description = "Get the current stock price for a ticker symbol."
            parameters = {
                "type": "object",
                "properties": {
                    "ticker": {"type": "string", "description": "e.g. AAPL"},
                },
                "required": ["ticker"],
            }

            async def run(self, ticker: str) -> str:
                price = await fetch_price(ticker)
                return f"{ticker}: ${price}"
    """

    name: str
    description: str
    parameters: dict  # JSON Schema for the tool's input

    @abstractmethod
    async def run(self, **kwargs) -> str:
        """
        Execute the tool with the given arguments.

        Always returns a plain string — the result shown to the LLM.
        Keep it concise and information-dense.
        """
        ...
