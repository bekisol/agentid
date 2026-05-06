"""
GitPerception — watch a git repository for new commits.

On each read:
  - Gets the latest commit hash
  - If changed: fetches the full diff since the last seen commit
  - Returns the diff as PerceptionData

No external dependencies — uses subprocess to call git.

Example
-------
    from agentid.brain.perception.git import GitPerception

    brain.add_perception(GitPerception(
        repo_path="/path/to/your/repo",
        max_diff_lines=500,
    ))
"""

from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path
from typing import Optional

from .base import Perception, PerceptionData


class GitPerception(Perception):
    """
    Observe a local git repository for new commits.

    Parameters
    ----------
    repo_path : str | Path
        Absolute path to the git repository root.
    branch : str
        Branch to watch. Default "HEAD" (current branch).
    max_diff_lines : int
        Maximum number of diff lines to include in the output.
        Large diffs are truncated to keep LLM context manageable.
    name : str | None
        Override the source name (default: "git:{repo_path.name}").
    """

    def __init__(
        self,
        repo_path: str | Path,
        branch: str = "HEAD",
        max_diff_lines: int = 400,
        name: Optional[str] = None,
    ) -> None:
        self._repo = Path(repo_path).resolve()
        self._branch = branch
        self._max_diff_lines = max_diff_lines
        super().__init__(name=name or f"git:{self._repo.name}")

    def _git(self, *args: str) -> str:
        """Run a git command in the repo directory, return stdout."""
        result = subprocess.run(
            ["git", "-C", str(self._repo), *args],
            capture_output=True,
            text=True,
            timeout=30,
        )
        return result.stdout.strip()

    async def read(self, last_state: Optional[str] = None) -> PerceptionData:
        """
        Read the current git state.

        If *last_state* is None or matches the current commit, returns
        the latest commit summary with changed=False.
        If a new commit is detected, returns the full diff since *last_state*.
        """
        loop = asyncio.get_event_loop()

        # Run git commands in thread pool (subprocess blocks)
        current_hash = await loop.run_in_executor(
            None, lambda: self._git("rev-parse", self._branch)
        )

        if not current_hash:
            return PerceptionData(
                source=self.name,
                content="Could not read git repository. Check the path and that git is installed.",
                changed=False,
                state_token="",
            )

        changed = last_state is not None and last_state != current_hash

        if not changed:
            # Return latest commit summary (unchanged)
            summary = await loop.run_in_executor(
                None,
                lambda: self._git("log", "-1", "--pretty=format:%h %s (%an, %ar)"),
            )
            return PerceptionData(
                source=self.name,
                content=f"Latest commit: {summary}\nNo new commits since last check.",
                changed=False,
                state_token=current_hash,
                metadata={"commit": current_hash},
            )

        # New commits detected — fetch the diff
        diff_range = f"{last_state}..{current_hash}" if last_state else current_hash

        log = await loop.run_in_executor(
            None,
            lambda: self._git(
                "log", "--oneline", "--stat", f"{diff_range}"
            ),
        )
        diff = await loop.run_in_executor(
            None,
            lambda: self._git("diff", last_state or "HEAD~1", current_hash),
        )

        # Truncate diff if too large
        diff_lines = diff.splitlines()
        truncated = ""
        if len(diff_lines) > self._max_diff_lines:
            diff = "\n".join(diff_lines[: self._max_diff_lines])
            truncated = (
                f"\n\n[Diff truncated — {len(diff_lines)} total lines, "
                f"showing first {self._max_diff_lines}]"
            )

        content = (
            f"New commits detected in {self._repo.name} ({self._branch}):\n\n"
            f"=== Commit Log ===\n{log}\n\n"
            f"=== Diff ===\n{diff}{truncated}"
        )

        # Collect file list from diff
        files_changed = await loop.run_in_executor(
            None,
            lambda: self._git("diff", "--name-only", last_state or "HEAD~1", current_hash),
        )

        return PerceptionData(
            source=self.name,
            content=content,
            changed=True,
            state_token=current_hash,
            metadata={
                "commit": current_hash,
                "previous_commit": last_state,
                "files_changed": files_changed.splitlines(),
                "diff_lines": len(diff_lines),
            },
        )
