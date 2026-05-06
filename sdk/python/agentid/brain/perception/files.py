"""
FilePerception — watch a file or directory for changes.

Detects changes via SHA-256 checksum. On change, returns the new file
contents (or a directory listing with modified files).

No external dependencies.

Example
-------
    from agentid.brain.perception.files import FilePerception

    brain.add_perception(FilePerception("/path/to/config.yaml"))
    brain.add_perception(FilePerception("/path/to/docs/", pattern="*.md"))
"""

from __future__ import annotations

import asyncio
import fnmatch
import hashlib
from pathlib import Path
from typing import Optional

from .base import Perception, PerceptionData


def _checksum(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()[:16]


class FilePerception(Perception):
    """
    Watch a file or directory for content changes.

    Parameters
    ----------
    path : str | Path
        File or directory to watch.
    pattern : str
        Glob pattern to filter files in a directory (default "*").
    max_chars : int
        Maximum characters of file content to include. Default 4000.
    name : str | None
        Override the source name.
    """

    def __init__(
        self,
        path: str | Path,
        pattern: str = "*",
        max_chars: int = 4000,
        name: Optional[str] = None,
    ) -> None:
        self._path = Path(path).resolve()
        self._pattern = pattern
        self._max_chars = max_chars
        super().__init__(name=name or f"files:{self._path.name}")

    def _read_file(self, p: Path) -> str:
        try:
            text = p.read_text(errors="replace")
            if len(text) > self._max_chars:
                return text[: self._max_chars] + f"\n... [truncated, {len(text)} total chars]"
            return text
        except OSError as exc:
            return f"[Cannot read: {exc}]"

    def _scan(self) -> tuple[str, str]:
        """Return (content_str, state_token)."""
        if not self._path.exists():
            return f"Path not found: {self._path}", "missing"

        if self._path.is_file():
            content = self._read_file(self._path)
            token = _checksum(self._path.read_bytes())
            return content, token

        # Directory: collect matching files
        files = sorted(
            f for f in self._path.rglob(self._pattern) if f.is_file()
        )
        if not files:
            return f"No files matching '{self._pattern}' in {self._path}", "empty"

        parts = []
        checksums = []
        for f in files[:20]:  # cap at 20 files
            rel = f.relative_to(self._path)
            raw = f.read_bytes()
            cs = _checksum(raw)
            checksums.append(cs)
            parts.append(f"--- {rel} ---\n{self._read_file(f)}\n")

        token = _checksum("".join(checksums).encode())
        content = "\n".join(parts)
        if len(files) > 20:
            content += f"\n[{len(files) - 20} more files not shown]"
        return content, token

    async def read(self, last_state: Optional[str] = None) -> PerceptionData:
        loop = asyncio.get_event_loop()
        content, token = await loop.run_in_executor(None, self._scan)
        changed = last_state is not None and last_state != token

        prefix = ""
        if changed:
            prefix = f"CHANGED: {self._path.name} has been modified.\n\n"

        return PerceptionData(
            source=self.name,
            content=prefix + content,
            changed=changed,
            state_token=token,
            metadata={"path": str(self._path)},
        )
