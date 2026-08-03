#!/usr/bin/env python3
"""Shared tracker detection for Pappardelle's Claude Code hooks.

Hooks run on every tool use, so this module deliberately avoids PyYAML and any
subprocess calls: config files are read with regexes and the results are cached
per process.

The workspace's issue key is recovered from the cwd, because pappardelle names
each worktree after the issue it was created for. That is trivial for Linear and
Jira (``STA-123``) but not for beads, whose IDs are lowercase with a content
hash for a suffix (``bd-a1b2``) and therefore indistinguishable from an ordinary
directory name like ``my-app``. For beads the match is anchored to the repo's
configured issue prefix so an arbitrary path component can never be mistaken for
an issue.
"""

import os
import re
import subprocess
from typing import Optional

_MAX_PARENT_WALK = 20

# Linear/Jira: uppercase alphabetic prefix, numeric suffix (STA-123).
_CLASSIC_KEY_RE = re.compile(r"^[A-Z]+-\d+$")

_PROVIDER_RE = re.compile(r"issue_tracker:\s*\n(?:\s*#[^\n]*\n)*\s+provider:\s*(\w+)")
_TEAM_PREFIX_RE = re.compile(r"^team_prefix:\s*[\"']?([A-Za-z0-9_-]+)[\"']?\s*$", re.MULTILINE)
_BEADS_PREFIX_RE = re.compile(r"^issue-prefix:\s*[\"']?([A-Za-z0-9_-]+)[\"']?\s*$", re.MULTILINE)


def find_up(filename: str, start: Optional[str] = None) -> Optional[str]:
    """Walk up from `start` (default cwd) looking for `filename`."""
    try:
        current = start if start is not None else os.getcwd()
    except OSError:
        return None

    for _ in range(_MAX_PARENT_WALK):
        candidate = os.path.join(current, filename)
        if os.path.exists(candidate):
            return candidate
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent

    return None


def _read(path: Optional[str]) -> str:
    if not path:
        return ""
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return ""


def get_tracker_provider(start: Optional[str] = None) -> str:
    """Read issue_tracker.provider from .pappardelle.yml. Defaults to "linear"."""
    match = _PROVIDER_RE.search(_read(find_up(".pappardelle.yml", start)))
    return match.group(1).strip() if match else "linear"


def get_beads_prefix(start: Optional[str] = None) -> Optional[str]:
    """The beads ID prefix for this repo.

    Prefers an explicit `issue-prefix` in .beads/config.yaml; falls back to
    pappardelle's own `team_prefix`, which serves the same role for the other
    trackers. Returns None when neither is set, in which case callers should
    keep the strict Linear/Jira key matching rather than guess.
    """
    match = _BEADS_PREFIX_RE.search(_read(find_up(os.path.join(".beads", "config.yaml"), start)))
    if match:
        return match.group(1).strip().lower()

    match = _TEAM_PREFIX_RE.search(_read(find_up(".pappardelle.yml", start)))
    if match:
        return match.group(1).strip().lower()

    return None


def get_main_repo_root(start: Optional[str] = None) -> Optional[str]:
    """The main repository root, resolved through worktrees.

    Every bd invocation must run here so all worktrees share one canonical
    database. A worktree carries its own checked-out `.beads/` directory, so
    running bd from inside one makes it auto-discover that copy and write the
    comment somewhere the ticket rail never reads.
    """
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=start,
        )
        if result.returncode == 0 and result.stdout.strip():
            return os.path.dirname(result.stdout.strip().rstrip("/"))
    except (OSError, subprocess.SubprocessError):
        pass

    return None


def _looks_like_beads_key(part: str, prefix: str) -> bool:
    return bool(re.fullmatch(re.escape(prefix) + r"-[a-z0-9]+(\.\d+){0,3}", part.lower()))


def _looks_like_classic_key(part: str) -> bool:
    return bool(_CLASSIC_KEY_RE.fullmatch(part))


def find_issue_key(cwd: Optional[str] = None) -> Optional[str]:
    """Recover the workspace's issue key from a worktree path.

    Expected shape: ~/.worktrees/<repo>/<issue-key>/...
    Returns None for the main worktree or any path with no issue in it.

    The Linear/Jira shape is checked first because it needs no file I/O, and
    update-status.py calls this on every hook event. Only when nothing matches
    does the beads path read config to learn the repo's issue prefix.
    """
    if cwd is None:
        try:
            cwd = os.getcwd()
        except OSError:
            return None

    parts = [p for p in cwd.split("/") if "-" in p]

    for part in parts:
        if _looks_like_classic_key(part):
            return part

    if not parts or get_tracker_provider(cwd) != "beads":
        return None

    beads_prefix = get_beads_prefix(cwd)
    if not beads_prefix:
        return None

    for part in parts:
        if _looks_like_beads_key(part, beads_prefix):
            return part

    return None
