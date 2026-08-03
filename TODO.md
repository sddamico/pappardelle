# TODO

Work through each item below. Check off items as you complete them by changing `- [ ]` to `- [x]` and adding a detailed explanation of what was done and how in parentheses after.

## Setup

- [x] Read and understand the issue description (Read Linear issue `pappardelle-1dg` via `bd show` and PR #5. Original prompt: "test session, investigate blinking cursor in tmux on ghostty". User clarified mid-session: not blinking — **flickering while typing**, and confirmed it is in **pappardelle's own TUI**, with scope = fix it in pappardelle.)
- [ ] Update the issue title if the auto-generated one isn't ideal (deferred until root cause is known — the current title says "blinking cursor", which is now known to be the wrong symptom)
- [ ] Update the issue description with implementation details

## Research & Planning

- [x] Explore the codebase to find relevant files (`source/cli.tsx` alt-screen + Ink `render()` setup, `source/app.tsx` root `<Box height={termHeight}>` + resize/zoom effects + `/`-search handling, `source/use-mouse.ts`, `source/logger.ts` stderr interception, and Ink internals in `node_modules/ink/build/ink.js` + `log-update.js` + `components/App.js`.)
- [x] Read key files to understand existing architecture and patterns (Traced Ink's two render paths: `outputHeight >= stdout.rows` → `clearTerminal + full frame` written straight to stdout; otherwise a `log-update` diff. app.tsx pins the root to `termHeight` on purpose — STA-1539 — to stay on the full-repaint path.)
- [x] Ask clarifying questions if requirements are ambiguous (Asked where the flicker appears and how to scope the fix. Answers: pappardelle's TUI; fix it in pappardelle.)
- [x] Plan the implementation approach and identify files to modify (After disproving hypotheses 1 and 2, the user's answers — zoomed full-screen list pane, both `/` search and the prompt dialog — pointed at repaint *presentation* rather than repaint volume. Confirmed via `tmux list-clients` that the live clients report `term=tmux-256color` and `sync=NO`, so tmux never batches. Fix site: `source/tmux.ts`, a new `enableSynchronizedOutput()` called from `setupPappardellLayout()`.)

## Implementation

- [x] Write failing tests first (Red phase) (Wrote `source/synchronized-output.test.ts` against `SYNC_TERMINAL_FEATURE` / `enableSynchronizedOutput` before either existed, so the suite failed to import.)
- [x] Implement the minimum code to make tests pass (Green phase) (Added `SYNC_TERMINAL_FEATURE = '*:Sync'` and `enableSynchronizedOutput()` to `source/tmux.ts`, issuing `set-option -ga terminal-features ,*:Sync` on both the outer and the `pappardelle_inner` socket via the file's existing injectable-runner pattern, and wired a single call into `setupPappardellLayout()` beside the other tmux set-options.)
- [x] Refactor if needed while keeping tests green (No refactor needed — the change is additive and reuses `OuterTmuxRunner` / `defaultInnerTmuxRunner`. Errors are swallowed so a tmux that rejects the option can never cost the user their panes.)
- [x] Build and verify changes compile (`npm run build` — tsc clean.)

## Testing

- [x] Run all relevant tests and verify they pass (`npx ava` — 1323 passed. 39 tests in `update-check.test.ts` remain pending after a timeout; verified **pre-existing** by re-running on a stashed pristine tree, which produces the identical 39. `npm test`'s prettier and xo steps fail repo-wide on files this branch never touched — no `.prettierrc`, so bare prettier disagrees with the committed `bracketSpacing: false` / `arrowParens: avoid` style; `npx xo source/word-boundary.test.ts` alone yields 66 identical errors. Not introduced here; new code follows the committed style.)
- [x] Manual testing / visual verification if applicable (Mechanism verified end-to-end against a *real* captured tmux client, not mocks — see the investigation log. With `terminal-features` at defaults a typing burst produced **0** synchronized updates downstream; with `*:Sync` appended, the same burst produced **11** `ESC[?2026h`/`ESC[?2026l` pairs. **Not visually confirmed** — the subjective flicker can only be judged by the user in Ghostty, which is the one open item on this fix.)

## Wrap Up

- [ ] Commit and push changes
- [ ] Update the PR title and body with summary and test plan
- [ ] Update issue state to "In Review"

---

## Investigation log

### Hypothesis 1 — a stray cursor is never hidden. DISPROVED.

Read the issue literally at first ("blinking cursor") and found that Ink's
`log-update` — its only `cli-cursor` caller inside `ink.js` — is bypassed on the
full-repaint path app.tsx pins us to. Wrote a fix emitting `\x1b[?25l` on
alt-screen entry.

Disproved by stack-tracing a real `render()` against a fake TTY stdout: Ink hides
the cursor from `App.componentDidMount` → `cliCursor.hide(this.props.stdout)`
(`node_modules/ink/build/components/App.js:365`), independent of `log-update`,
and restores it in `componentWillUnmount`. The cursor is already handled. Fix
reverted; nothing committed.

### Hypothesis 2 — the per-frame `clearTerminal` causes the flicker. DISPROVED.

On the full-repaint path Ink writes `\x1b[2J\x1b[3J\x1b[H` + the entire frame on
*every* paint (`ansi-escapes` `clearTerminal`) — a full screen erase *including
scrollback* per keystroke. Plausible flicker source.

Disproved with two measurements against a real captured tmux client
(`script -q … tmux attach`, sessions sized 80x24 and 100x30):

1. Synthetic A/B — 100 full-screen frames painted as `clearTerminal + frame`
   vs. `cursor-home + per-line \x1b[K`. tmux forwarded **zero** `\x1b[2J` and
   **zero** `\x1b[3J` downstream in either mode, at near-identical byte volume
   (45056 vs 40960). tmux absorbs screen-wide erases into its own grid and emits
   only a minimal diff to the outer terminal.
2. Real TUI — ran `dist/cli.js --no-layout` in a scratch repo (scratchpad
   `repro/`, minimal `.pappardelle.yml`), opened `/` search, typed 10 characters.
   tmux forwarded **2372 bytes total against a 2362-byte idle baseline — ~1 byte
   per keystroke**. That is a perfect incremental update; there is no flicker
   mechanism in the output volume.

Repeated with a realistic list (51 spaces seeded into the registry, 100x40 pane),
where each keystroke re-filters most of the screen: **~114 bytes per keystroke**
forwarded. Still nowhere near a full repaint. Output volume is simply not the
problem.

### Hypothesis 3 — tmux never batches the repaint. CONFIRMED, and fixed.

The user's answers reframed it: the flicker happens with the list pane **zoomed
full-screen**, in both the `/` search and the prompt dialog — i.e. it tracks
repaint *area*, not repaint *volume*. That points at how the repaint is
*presented* rather than how much is sent.

tmux wraps a redraw in DEC 2026 synchronized-output markers (`ESC [ ? 2026 h` …
`ESC [ ? 2026 l`) only when it believes the client's terminal supports Sync,
which it infers from the client's TERM. Checked the live server:

```
$ tmux list-clients -F '#{client_tty} #{client_termname} …'
  tty=/dev/ttys010 term=tmux-256color sync=NO
  tty=/dev/ttys011 term=tmux-256color sync=NO
```

`tmux-256color` advertises no Sync — and nested clients are the *normal* shape
for this app, since the claude and companion panes each host a
`tmux -L pappardelle_inner attach`. So tmux streams every repaint out unbatched
and Ghostty can present a half-drawn frame. That is the flicker, and it is worst
exactly where the user sees it: a zoomed pane repainting full-screen per
keystroke.

Confirmed by A/B against a real captured client, running the actual TUI:

| `terminal-features`  | client | synchronized updates during a typing burst |
| -------------------- | ------ | ------------------------------------------ |
| tmux defaults        | sync=NO | **0** BSU / 0 ESU                         |
| `*:Sync` appended    | sync=NO | **11** BSU / 11 ESU                       |

The fix makes pappardelle append `*:Sync` to `terminal-features` on both sockets
during layout setup.

### Caveats worth carrying into review

- **Not visually confirmed.** The measurements prove tmux now batches; whether
  the flicker is gone can only be judged by the user in Ghostty.
- **`terminal-features` is server-scope.** tmux offers no session or window
  scope, so on the outer socket this touches the user's whole tmux server. We
  append (`-ga`) rather than assign so user config survives, and terminals
  without DEC 2026 ignore the private mode. The inner socket is pappardelle's
  own server, so there it is free.
- During investigation the outer tmux server's `terminal-features` was
  temporarily set by an experiment; it was restored to tmux's built-in defaults
  (`xterm*:…`, `screen*:title`, `rxvt*:ignorefkeys`), matching a `~/.tmux.conf`
  that configures none.
