"""AgentID integration for LlamaIndex.

Install::

    pip install llamaindex-agentid

Quick start::

    from llama_index.core import VectorStoreIndex, SimpleDirectoryReader
    from llamaindex_agentid import AgentIDQueryEngine, get_agentid_tools

    # Wrap any query engine — outputs are automatically signed
    documents = SimpleDirectoryReader("data").load_data()
    index = VectorStoreIndex.from_documents(documents)

    engine = AgentIDQueryEngine(
        query_engine=index.as_query_engine(),
        name="research-agent",
        capabilities=["research", "summarization"],
        owner="team@company.com",
        registry_url="https://api.agentid-protocol.com",
    )
    print(f"Agent DID: {engine.did}")

    response = engine.query("What are the main AI safety concerns?")
    assert engine.verify_response(response)  # True

    # Add discovery + verification tools to a ReAct agent
    from llama_index.core.agent import ReActAgent
    from llama_index.llms.openai import OpenAI

    tools = get_agentid_tools(registry_url="https://api.agentid-protocol.com")
    agent = ReActAgent.from_tools(tools, llm=OpenAI(model="gpt-4o"), verbose=True)

"""

from llamaindex_agentid.engine import AgentIDQueryEngine
from llamaindex_agentid.tools import get_agentid_tools

__version__ = "0.1.0"
__all__ = ["AgentIDQueryEngine", "get_agentid_tools"]
