#!/bin/bash

# Test: the tracker-issue section of a placeholder PR/MR body
#
# The GitHub PR body used to hardcode "## Linear Issue" plus a
# linear.app/stardust-labs URL built from the issue key, so a Jira- or
# beads-configured repo got a heading naming the wrong tracker above a link
# that resolves to nothing. The GitLab MR body had the opposite problem: no
# issue reference at all.
#
# What this exercises:
# - build_issue_section (heading per tracker; URL when the tracker has a web
#   page, bare key when it doesn't)
# - create-github-pr.sh renders that section into the PR body
# - create_pr's GitLab branch renders it into the MR description
#
# Usage: ./test-pr-issue-section.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/provider-helpers.sh"

PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
RESET='\033[0m'

cleanup() {
    if [[ -n "${TMPDIR_ROOT:-}" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}
trap cleanup EXIT

assert_eq() {
    local test_name="$1"
    local expected="$2"
    local actual="$3"

    if [[ "$actual" == "$expected" ]]; then
        echo -e "  ${GREEN}PASS${RESET} $test_name"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${RESET} $test_name"
        echo "    Expected: \"$expected\""
        echo "    Actual:   \"$actual\""
        FAIL=$((FAIL + 1))
    fi
}

assert_contains() {
    local test_name="$1"
    local needle="$2"
    local haystack="$3"

    if [[ "$haystack" == *"$needle"* ]]; then
        echo -e "  ${GREEN}PASS${RESET} $test_name"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${RESET} $test_name"
        echo "    Expected to contain: \"$needle\""
        echo "    Actual:              \"$haystack\""
        FAIL=$((FAIL + 1))
    fi
}

assert_not_contains() {
    local test_name="$1"
    local needle="$2"
    local haystack="$3"

    if [[ "$haystack" != *"$needle"* ]]; then
        echo -e "  ${GREEN}PASS${RESET} $test_name"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${RESET} $test_name"
        echo "    Expected NOT to contain: \"$needle\""
        FAIL=$((FAIL + 1))
    fi
}

TMPDIR_ROOT=$(mktemp -d)

cat > "$TMPDIR_ROOT/.pappardelle-linear.yml" <<'EOF'
version: 1
team_prefix: STA
issue_tracker:
  provider: linear
vcs_host:
  provider: github
EOF

cat > "$TMPDIR_ROOT/.pappardelle-jira.yml" <<'EOF'
version: 1
team_prefix: KAN
issue_tracker:
  provider: jira
  base_url: https://example.atlassian.net
vcs_host:
  provider: github
EOF

cat > "$TMPDIR_ROOT/.pappardelle-beads.yml" <<'EOF'
version: 1
team_prefix: pap
issue_tracker:
  provider: beads
vcs_host:
  provider: github
EOF

cat > "$TMPDIR_ROOT/.pappardelle-beads-gitlab.yml" <<'EOF'
version: 1
team_prefix: pap
issue_tracker:
  provider: beads
vcs_host:
  provider: gitlab
EOF

# ==========================================================================

echo -e "${BOLD}Test: build_issue_section — heading names the configured tracker${RESET}"

result=$(build_issue_section "STA-123" "https://linear.app/acme/issue/STA-123" \
    "$TMPDIR_ROOT/.pappardelle-linear.yml")
assert_eq "Linear → heading + API URL" \
    "## Linear Issue
https://linear.app/acme/issue/STA-123" "$result"

result=$(build_issue_section "KAN-9" "https://example.atlassian.net/browse/KAN-9" \
    "$TMPDIR_ROOT/.pappardelle-jira.yml")
assert_eq "Jira → heading + browse URL" \
    "## Jira Issue
https://example.atlassian.net/browse/KAN-9" "$result"

# ==========================================================================

echo -e "\n${BOLD}Test: build_issue_section — beads has no web page${RESET}"

result=$(build_issue_section "pap-a1b2" "" "$TMPDIR_ROOT/.pappardelle-beads.yml")
assert_eq "beads → heading + bare key" \
    "## Beads Issue
pap-a1b2" "$result"

assert_not_contains "beads section carries no linear.app link" "linear.app" "$result"

# A tracker whose URL lookup came back empty must still name the issue rather
# than emit a dangling heading.
result=$(build_issue_section "STA-123" "" "$TMPDIR_ROOT/.pappardelle-linear.yml")
assert_eq "empty URL falls back to the key" \
    "## Linear Issue
STA-123" "$result"

# ==========================================================================

echo -e "\n${BOLD}Test: create-github-pr.sh renders the section into the PR body${RESET}"

FAKE_BIN="$TMPDIR_ROOT/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/gh" <<EOF
#!/bin/bash
printf '%s\n' "\$@" > "$TMPDIR_ROOT/gh-argv.txt"
prev=""
for arg in "\$@"; do
    if [[ "\$prev" == "--body" ]]; then
        printf '%s' "\$arg" > "$TMPDIR_ROOT/gh-body.txt"
    fi
    prev="\$arg"
done
echo "https://github.com/acme/repo/pull/42"
EOF
chmod +x "$FAKE_BIN/gh"

# A worktree with a pushable origin, so the script's commit/push/reset dance
# runs for real instead of being stubbed around.
make_repo() {
    local name="$1" branch="$2"
    local remote="$TMPDIR_ROOT/$name-origin.git"
    local work="$TMPDIR_ROOT/$name"
    git init --quiet --bare "$remote"
    git init --quiet -b main "$work"
    git -C "$work" config user.email test@example.com
    git -C "$work" config user.name Test
    git -C "$work" commit --quiet --allow-empty -m "base"
    git -C "$work" remote add origin "$remote"
    git -C "$work" push --quiet -u origin main >/dev/null 2>&1
    git -C "$work" checkout --quiet -b "$branch"
    echo "$work"
}

WORK=$(make_repo beads-gh pap-a1b2)
PATH="$FAKE_BIN:$PATH" "$SCRIPT_DIR/create-github-pr.sh" \
    --issue-key pap-a1b2 \
    --title "Add dark mode" \
    --worktree "$WORK" \
    --config "$TMPDIR_ROOT/.pappardelle-beads.yml" \
    --issue-url "" \
    --prompt "add dark mode" > "$TMPDIR_ROOT/gh-out.json" 2>/dev/null

body=$(cat "$TMPDIR_ROOT/gh-body.txt" 2>/dev/null || echo "MISSING")
assert_contains "beads PR body names the beads issue" "## Beads Issue" "$body"
assert_contains "beads PR body carries the bare key" "pap-a1b2" "$body"
assert_not_contains "beads PR body has no Linear heading" "Linear Issue" "$body"
assert_not_contains "beads PR body has no linear.app URL" "linear.app" "$body"
assert_contains "PR body still quotes the original prompt" "> add dark mode" "$body"

WORK=$(make_repo linear-gh STA-123)
PATH="$FAKE_BIN:$PATH" "$SCRIPT_DIR/create-github-pr.sh" \
    --issue-key STA-123 \
    --title "Add dark mode" \
    --worktree "$WORK" \
    --config "$TMPDIR_ROOT/.pappardelle-linear.yml" \
    --issue-url "https://linear.app/acme/issue/STA-123" \
    --prompt "add dark mode" > /dev/null 2>&1

body=$(cat "$TMPDIR_ROOT/gh-body.txt" 2>/dev/null || echo "MISSING")
assert_contains "Linear PR body keeps its heading" "## Linear Issue" "$body"
# The workspace slug comes from the tracker, never from a hardcoded constant.
assert_contains "Linear PR body uses the passed URL's workspace" \
    "https://linear.app/acme/issue/STA-123" "$body"
assert_not_contains "no hardcoded stardust-labs workspace" "stardust-labs" "$body"

# ==========================================================================

echo -e "\n${BOLD}Test: create_pr passes the tracker URL through to GitHub${RESET}"

WORK=$(make_repo passthru-gh KAN-9)
PATH="$FAKE_BIN:$PATH" create_pr \
    --issue-key KAN-9 \
    --title "Add dark mode" \
    --worktree "$WORK" \
    --config "$TMPDIR_ROOT/.pappardelle-jira.yml" \
    --issue-url "https://example.atlassian.net/browse/KAN-9" \
    --prompt "add dark mode" > /dev/null 2>&1

body=$(cat "$TMPDIR_ROOT/gh-body.txt" 2>/dev/null || echo "MISSING")
assert_contains "Jira PR body names Jira" "## Jira Issue" "$body"
assert_contains "Jira PR body links the browse URL" \
    "https://example.atlassian.net/browse/KAN-9" "$body"
assert_not_contains "Jira PR body has no linear.app URL" "linear.app" "$body"

# ==========================================================================

echo -e "\n${BOLD}Test: GitLab MR description carries the issue section${RESET}"

cat > "$FAKE_BIN/glab" <<EOF
#!/bin/bash
prev=""
for arg in "\$@"; do
    if [[ "\$prev" == "--description" ]]; then
        printf '%s' "\$arg" > "$TMPDIR_ROOT/glab-body.txt"
    fi
    prev="\$arg"
done
echo "https://gitlab.example.com/acme/repo/-/merge_requests/7"
EOF
chmod +x "$FAKE_BIN/glab"

WORK=$(make_repo beads-gl pap-a1b2)
result=$(PATH="$FAKE_BIN:$PATH" create_pr \
    --issue-key pap-a1b2 \
    --title "Add dark mode" \
    --worktree "$WORK" \
    --config "$TMPDIR_ROOT/.pappardelle-beads-gitlab.yml" \
    --issue-url "" \
    --prompt "add dark mode" 2>/dev/null)

body=$(cat "$TMPDIR_ROOT/glab-body.txt" 2>/dev/null || echo "MISSING")
assert_contains "MR description names the beads issue" "## Beads Issue" "$body"
assert_contains "MR description carries the bare key" "pap-a1b2" "$body"
assert_contains "MR description still quotes the original prompt" \
    "> add dark mode" "$body"
assert_contains "create_pr still reports the MR URL" \
    "merge_requests/7" "$result"

# ==========================================================================

echo ""
TOTAL=$((PASS + FAIL))
if [[ "$FAIL" -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}All $TOTAL tests passed${RESET}"
    exit 0
else
    echo -e "${RED}${BOLD}$FAIL of $TOTAL tests failed${RESET}"
    exit 1
fi
