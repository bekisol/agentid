"""
OnChangeTrigger — fire the brain whenever a perception source changes.

Unlike schedule-based triggers, this one polls a perception source at a
configurable interval and only fires when the source reports a change.

Example
-------
    brain.add_trigger(
        OnChangeTrigger(
            GitPerception(repo_path="/code/myrepo"),
            poll_interval=300,   # check every 5 minutes
        )
    )
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from ..perception.base import Perception

logger = logging.getLogger(__name__)


class OnChangeTrigger:
    """
    Fire the brain when a perception source changes.

    Polls the perception source every *poll_interval* seconds.
    When the content is different from the last observed state, the trigger
    fires and the brain's think cycle runs.

    Parameters
    ----------
    perception : Perception
        The data source to watch for changes.
    poll_interval : int
        How often to poll the source, in seconds. Default: 60.
    fire_on_first : bool
        If True, fire immediately on the first poll (treat initial state as
        "new"). If False, only fire when the state actually changes from a
        previously seen value. Default: False.

    Notes
    -----
    The trigger keeps its own internal `_last_state` separate from
    BrainMemory. This ensures that the brain's think cycle still sees the
    correct "changed" flag when it reads the same perception source.
    """

    def __init__(
        self,
        perception: Perception,
        poll_interval: int = 60,
        fire_on_first: bool = False,
    ) -> None:
        if poll_interval < 10:
            raise ValueError("OnChangeTrigger: minimum poll_interval is 10 seconds")
        self.perception = perception
        self.poll_interval = poll_interval
        self.fire_on_first = fire_on_first
        self._last_state: Optional[str] = None
        self._name = f"onChange:{perception.name}"

    async def wait_until_next(self) -> None:
        """
        Poll the perception source until a change is detected, then return.

        On the very first call, if *fire_on_first* is False, this records
        the baseline state and waits for a subsequent change.
        """
        first_run = self._last_state is None

        while True:
            try:
                data = await self.perception.read(self._last_state)
            except Exception as exc:
                logger.warning(
                    "[brain/%s] perception read error: %s — retrying in %ds",
                    self._name,
                    exc,
                    self.poll_interval,
                )
                await asyncio.sleep(self.poll_interval)
                continue

            changed = data.changed or (first_run and self.fire_on_first)

            if changed and not (first_run and not self.fire_on_first):
                # State changed (or fire_on_first on first run) — fire!
                logger.debug(
                    "[brain/%s] change detected — token=%s",
                    self._name,
                    data.state_token[:16] if data.state_token else "?",
                )
                self._last_state = data.state_token
                return

            # Record baseline / no change yet — keep polling
            self._last_state = data.state_token
            first_run = False
            await asyncio.sleep(self.poll_interval)

    def __repr__(self) -> str:
        return (
            f"OnChangeTrigger(perception={self.perception.name!r}, "
            f"poll_interval={self.poll_interval}s)"
        )
