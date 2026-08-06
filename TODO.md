# TODO

Work through each item below. Check off items as you complete them by changing `- [ ]` to `- [x]` and adding a detailed explanation of what was done and how in parentheses after.

## Setup

- [x] Read and understand the issue description (`bd show pappardelle-7vt` — "when creating a new workspace with two line mode active, the 'setting up the new space' text should appear in the top line not the bottom")
- [x] Update the issue title if the auto-generated one isn't ideal (retitled to "Two-line list layout: keep a pending row's progress text on the key line")
- [x] Update the issue description with implementation details (described the cause and the fix, kept the Original prompt block)

## Research & Planning

- [x] Explore the codebase to find relevant files (two-line layout lives in `source/components/SpaceListItem.tsx`, `source/list-view-sizing.ts`, `source/config.ts` — it was uncommitted WIP on the `beads-provider` worktree, not on this branch)
- [x] Read key files to understand existing architecture and patterns (`SpaceListItem` renders a key line plus an always-emitted indented title line; pending rows carry `pendingTitle` from `source/session-routing.ts`)
- [x] Ask clarifying questions if requirements are ambiguous (asked twice — confirmed "two line mode" is the TUI row layout and that the base is the `beads-provider` WIP)
- [x] Plan the implementation approach and identify files to modify (snapshot the `beads-provider` WIP as a base commit here, then add a pure `titleSharesKeyLine` predicate and route pending rows through it)

## Implementation

- [x] Write failing tests first (Red phase) (three `titleSharesKeyLine` cases in `source/list-view-sizing.test.ts`; the import failed until the helper existed)
- [x] Implement the minimum code to make tests pass (Green phase) (added `titleSharesKeyLine` to `source/list-view-sizing.ts`)
- [x] Refactor if needed while keeping tests green (replaced the `isTwoLine` branches in `SpaceListItem` with `inlineTitle`, so the title-width budget, the emoji ink-pad correction, and the row widths all follow one predicate instead of repeating the layout test)
- [x] Build and verify changes compile (`npm run build` clean)

## Testing

- [x] Run all relevant tests and verify they pass (`npx ava`: 1568 passed, up from 1565 on the base WIP; same 39 pre-existing timeouts. `npx xo`: 7 errors / 10 warnings, identical to the base WIP — all in its own `integration-tests/verify-beads.ts`)
- [x] Manual testing / visual verification if applicable (rendered the compiled component through `ink-testing-library` for description-route, issue-route, and real spaces in both layouts — the progress text now sits on the top line with a blank second row, and real spaces are unchanged)

## Wrap Up

- [x] Commit and push changes (two commits: the `beads-provider` WIP snapshot, then the fix)
- [x] Update the PR title and body with summary and test plan (kept the Original prompt block)
- [x] Update issue state to "In Review"
