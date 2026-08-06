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
configured issue prefixes so an arbitrary path component can never be mistaken
for an issue.
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

# Per-profile prefix sources, which are indented and therefore missed by the
# anchored top-level patterns above. `tracker_projects` entries name beads ID
# prefixes the same way they name Linear/Jira projects for the other trackers.
_PROFILE_TEAM_PREFIX_RE = re.compile(
    r"^\s+team_prefix:\s*[\"']?([A-Za-z0-9_-]+)[\"']?\s*$", re.MULTILINE
)
_TRACKER_PROJECTS_RE = re.compile(
    r"^[ \t]+tracker_projects:[ \t]*$((?:\n[ \t]*-[^\n]*)+)", re.MULTILINE
)
_LIST_ITEM_RE = re.compile(r"^[ \t]*-[ \t]*[\"']?([^\"'\n]+?)[\"']?[ \t]*$", re.MULTILINE)


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


def get_beads_prefixes(start: Optional[str] = None) -> list[str]:
    """Every beads ID prefix this repo can mint keys under.

    A database is not limited to one prefix: profiles carry their own
    `team_prefix`, and their `tracker_projects` name beads prefixes the way they
    name Linear/Jira projects for the other trackers. A workspace created under
    any of them is a real workspace, so matching only the database prefix leaves
    those hooks publishing under the fallback branch key and skipping comments.

    Mirrors `getBeadsPrefixes` in source/config.ts. Order is stable but not
    meaningful; callers test membership.
    """
    prefixes: list[str] = []

    def add(value: Optional[str]) -> None:
        if not value:
            return
        cleaned = value.strip().lower()
        if cleaned and cleaned not in prefixes:
            prefixes.append(cleaned)

    add(get_beads_prefix(start))

    config = _read(find_up(".pappardelle.yml", start))
    for match in _PROFILE_TEAM_PREFIX_RE.finditer(config):
        add(match.group(1))

    for block in _TRACKER_PROJECTS_RE.finditer(config):
        for item in _LIST_ITEM_RE.finditer(block.group(1)):
            add(item.group(1))

    return prefixes


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
    return bool(re.fullmatch(re.escape(prefix) + r"-[a-z0-9_]+(\.\d+){0,3}", part.lower()))


def _looks_like_classic_key(part: str) -> bool:
    return bool(_CLASSIC_KEY_RE.fullmatch(part))


def find_issue_key(cwd: Optional[str] = None) -> Optional[str]:
    """Recover the workspace's issue key from a worktree path.

    Expected shape: ~/.worktrees/<repo>/<issue-key>/...
    Returns None for the main worktree or any path with no issue in it.

    The Linear/Jira shape is checked first because it needs no file I/O, and
    update-status.py calls this on every hook event. Only when nothing matches
    does the beads path read config to learn the repo's issue prefixes.
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

    beads_prefixes = get_beads_prefixes(cwd)
    if not beads_prefixes:
        return None

    for part in parts:
        for prefix in beads_prefixes:
            if _looks_like_beads_key(part, prefix):
                return part

    return None
