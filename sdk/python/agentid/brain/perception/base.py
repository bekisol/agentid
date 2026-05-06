"""
Perception base class and PerceptionData.

A Perception source is anything the agent can observe:
  - a git repository
  - a file or directory
  - an HTTP API endpoint
  - a database query result

Each source implements:
  read()  → PerceptionData   — fetch current state
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional


@dataclass
class PerceptionData:
    """
    The result of one read from a perception source.

    Attributes
    ----------
    source : str
        Identifier for this perception source (e.g. "git:my-repo").
    content : str
        The actual observed data — a diff, file contents, API response, etc.
    changed : bool
        True if the data is different from the last time this source was read.
    state_token : str
        An opaque string representing the current state (commit hash, checksum,
        etag, etc.). Stored in memory to detect future changes.
    metadata : dict
        Source-specific extra info (file path, commit message, URL, …).
    timestamp : datetime
        When this observation was made.
    """

    source: str
    content: str
    changed: bool
    state_token: str
    metadata: dict = field(default_factory=dict)
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def __str__(self) -> str:
        changed_tag = "CHANGED" if self.changed else "unchanged"
        return (
            f"[{self.source} | {changed_tag} | {self.timestamp.strftime('%Y-%m-%d %H:%M')}]\n"
            f"{self.content[:2000]}"
        )


class Perception(ABC):
    """
    Abstract base for all perception sources.

    Subclasses implement :meth:`read` to fetch current state.
    The brain calls :meth:`read` on every think cycle and decides
    what to do based on the returned :class:`PerceptionData`.
    """

    def __init__(self, name: Optional[str] = None) -> None:
        self.name = name or self.__class__.__name__

    @abstractmethod
    async def read(self, last_state: Optional[str] = None) -> PerceptionData:
        """
        Observe the data source and return the current state.

        Parameters
        ----------
        last_state : str | None
            The state token from the previous read (from BrainMemory).
            Use this to detect changes and compute diffs.

        Returns
        -------
        PerceptionData
        """
        ...
