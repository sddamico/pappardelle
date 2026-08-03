#!/usr/bin/env python3
"""Tests for tracker_config.py — provider detection and issue-key recovery."""

import importlib.util
import os
from pathlib import Path

import pytest

_module_path = Path(__file__).parent / "tracker_config.py"
_spec = importlib.util.spec_from_file_location("tracker_config", _module_path)
assert _spec and _spec.loader
tracker_config = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tracker_config)


def write_repo(root: Path, pappardelle: str = "", beads: str | None = None) -> Path:
    """Lay out a repo with a .pappardelle.yml and optionally a .beads/config.yaml."""
    root.mkdir(parents=True, exist_ok=True)
    (root / ".pappardelle.yml").write_text(pappardelle)
    if beads is not None:
        (root / ".beads").mkdir(exist_ok=True)
        (root / ".beads" / "config.yaml").write_text(beads)
    return root


# ---------------------------------------------------------------------------
# get_tracker_provider
# ---------------------------------------------------------------------------


def test_provider_defaults_to_linear_without_config(tmp_path):
    assert tracker_config.get_tracker_provider(str(tmp_path)) == "linear"


def test_provider_reads_beads(tmp_path):
    repo = write_repo(tmp_path, "version: 1\nissue_tracker:\n  provider: beads\n")
    assert tracker_config.get_tracker_provider(str(repo)) == "beads"


def test_provider_reads_jira(tmp_path):
    repo = write_repo(
        tmp_path,
        "version: 1\nissue_tracker:\n  provider: jira\n  base_url: https://x.atlassian.net\n",
    )
    assert tracker_config.get_tracker_provider(str(repo)) == "jira"


def test_provider_skips_comment_lines_between_key_and_value(tmp_path):
    repo = write_repo(
        tmp_path,
        "version: 1\nissue_tracker:\n  # which tracker\n  provider: beads\n",
    )
    assert tracker_config.get_tracker_provider(str(repo)) == "beads"


def test_provider_found_from_a_subdirectory(tmp_path):
    repo = write_repo(tmp_path, "version: 1\nissue_tracker:\n  provider: beads\n")
    nested = repo / "src" / "deep"
    nested.mkdir(parents=True)
    assert tracker_config.get_tracker_provider(str(nested)) == "beads"


# ---------------------------------------------------------------------------
# get_beads_prefix
# ---------------------------------------------------------------------------


def test_beads_prefix_prefers_beads_config(tmp_path):
    repo = write_repo(
        tmp_path,
        "version: 1\nteam_prefix: fallback\n",
        beads='issue-prefix: "myproj"\n',
    )
    assert tracker_config.get_beads_prefix(str(repo)) == "myproj"


def test_beads_prefix_falls_back_to_team_prefix(tmp_path):
    # .beads/config.yaml ships with issue-prefix commented out, so team_prefix
    # is what most repos will actually have set.
    repo = write_repo(tmp_path, "version: 1\nteam_prefix: Pap\n", beads='# issue-prefix: ""\n')
    assert tracker_config.get_beads_prefix(str(repo)) == "pap"


def test_beads_prefix_is_none_when_unset(tmp_path):
    repo = write_repo(tmp_path, "version: 1\n")
    assert tracker_config.get_beads_prefix(str(repo)) is None


# ---------------------------------------------------------------------------
# find_issue_key
# ---------------------------------------------------------------------------


def test_finds_classic_issue_key(tmp_path):
    repo = write_repo(tmp_path / "STA-123", "version: 1\n")
    assert tracker_config.find_issue_key(str(repo)) == "STA-123"


def test_ignores_ordinary_directory_names(tmp_path):
    repo = write_repo(tmp_path / "my-app", "version: 1\n")
    assert tracker_config.find_issue_key(str(repo)) is None


def test_finds_beads_key_when_prefix_matches(tmp_path):
    repo = write_repo(
        tmp_path / "pap-a1b2",
        "version: 1\nteam_prefix: pap\nissue_tracker:\n  provider: beads\n",
    )
    assert tracker_config.find_issue_key(str(repo)) == "pap-a1b2"


def test_finds_beads_child_key(tmp_path):
    repo = write_repo(
        tmp_path / "pap-a1b2.1",
        "version: 1\nteam_prefix: pap\nissue_tracker:\n  provider: beads\n",
    )
    assert tracker_config.find_issue_key(str(repo)) == "pap-a1b2.1"


def test_beads_matching_is_anchored_to_the_configured_prefix(tmp_path):
    # Without this anchor, any hyphenated path component would read as an issue.
    repo = write_repo(
        tmp_path / "some-dir",
        "version: 1\nteam_prefix: pap\nissue_tracker:\n  provider: beads\n",
    )
    assert tracker_config.find_issue_key(str(repo)) is None


def test_beads_key_ignored_when_no_prefix_is_configured(tmp_path):
    repo = write_repo(tmp_path / "pap-a1b2", "version: 1\nissue_tracker:\n  provider: beads\n")
    assert tracker_config.find_issue_key(str(repo)) is None


def test_lowercase_key_ignored_under_a_non_beads_tracker(tmp_path):
    repo = write_repo(tmp_path / "pap-a1b2", "version: 1\nteam_prefix: pap\n")
    assert tracker_config.find_issue_key(str(repo)) is None


if __name__ == "__main__":
    raise SystemExit(pytest.main([os.path.abspath(__file__), "-v"]))
