"""
Schedule-based triggers: IntervalTrigger and DailyTrigger.

No external dependencies — uses asyncio.sleep.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone, timedelta


class IntervalTrigger:
    """
    Fire the brain every *seconds* seconds.

    Example
    -------
        brain.add_trigger(IntervalTrigger(seconds=3600))  # every hour
    """

    def __init__(self, seconds: int) -> None:
        if seconds < 10:
            raise ValueError("IntervalTrigger: minimum interval is 10 seconds")
        self.seconds = seconds
        self._name = f"interval:{seconds}s"

    async def wait_until_next(self) -> None:
        """Sleep until the trigger should fire."""
        await asyncio.sleep(self.seconds)

    def __repr__(self) -> str:
        return f"IntervalTrigger(seconds={self.seconds})"


class DailyTrigger:
    """
    Fire the brain once per day at a specific UTC time.

    Example
    -------
        brain.add_trigger(DailyTrigger(hour=9, minute=0))  # 9:00 AM UTC daily
    """

    def __init__(self, hour: int = 9, minute: int = 0) -> None:
        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            raise ValueError("DailyTrigger: hour must be 0-23, minute 0-59")
        self.hour = hour
        self.minute = minute
        self._name = f"daily:{hour:02d}:{minute:02d}UTC"

    async def wait_until_next(self) -> None:
        """Sleep until the next occurrence of the configured UTC time."""
        now = datetime.now(timezone.utc)
        target = now.replace(hour=self.hour, minute=self.minute, second=0, microsecond=0)
        if target <= now:
            target += timedelta(days=1)
        wait_seconds = (target - now).total_seconds()
        await asyncio.sleep(wait_seconds)

    def __repr__(self) -> str:
        return f"DailyTrigger(hour={self.hour}, minute={self.minute}, tz=UTC)"
