"""
Test 5 — Perception layer (FilePerception, APIPerception, GitPerception)
========================================================================
What it does: watches a data source and reports whether it changed since
the last check. Used by OnChangeTrigger to decide when to wake the brain.

FilePerception  — watches files by SHA-256 checksum
APIPerception   — polls an HTTP endpoint and checks for changes
GitPerception   — checks git repo for new commits

Run:
    python3 examples/05_perception.py

What you should see:
  - First read: changed=True (no prior state)
  - Second read: changed=False (same file, nothing changed)
  - After modification: changed=True again
"""

import asyncio
import sys
import os
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agentid.brain.perception.files import FilePerception
from agentid.brain.perception.api import APIPerception


async def test_file_perception():
    print("=" * 50)
    print("FilePerception")
    print("=" * 50)

    # Create a temp file to watch
    with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
        f.write("oil price: $82.00\n")
        path = f.name

    perception = FilePerception(path, name="price-file")

    # First read — no prior state, changed=False (nothing to compare against yet)
    data1 = await perception.read(last_state=None)
    print(f"First read  → changed={data1.changed}  (no prior state — expected False)")
    print(f"  Content preview: {data1.content[:60]!r}")
    state = data1.state_token

    # Second read — same file, nothing changed
    data2 = await perception.read(last_state=state)
    print(f"Second read → changed={data2.changed}  (same file — expected False)")

    # Modify the file
    with open(path, 'w') as f:
        f.write("oil price: $89.50\n")  # price spiked!

    data3 = await perception.read(last_state=state)
    print(f"After edit  → changed={data3.changed}  (file changed, expected True)")
    print(f"  New content: {data3.content[:60]!r}")

    os.unlink(path)


async def test_api_perception():
    print()
    print("=" * 50)
    print("APIPerception (polls a public JSON endpoint)")
    print("=" * 50)

    # Uses httpbin.org — always returns 200 with current time in JSON
    perception = APIPerception(
        url="https://httpbin.org/json",
        name="httpbin-check",
    )

    data1 = await perception.read(last_state=None)
    print(f"First read  → changed={data1.changed}, source={data1.source}")
    print(f"  State token: {data1.state_token[:40]}...")

    data2 = await perception.read(last_state=data1.state_token)
    print(f"Second read → changed={data2.changed}  (same response, expected False)")


async def main():
    await test_file_perception()
    await test_api_perception()
    print()
    print("Perception tests done.")


asyncio.run(main())
