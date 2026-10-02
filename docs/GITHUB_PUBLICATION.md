# Private GitHub beta — 2026-10-02

The core desktop and terminal companions are implemented and suitable for a
private source review. This is not a completed public product release.

## Published branches

- `main`: tested baseline plus current plugin validation, dependency patches,
  portable tests, GitHub CI, and visual documentation.
- `wip/terminal-focus-20261002`: a preservation snapshot of the original
  uncommitted focus-button work. It incorrectly treats `WT_SESSION` as a window
  ID and must not be merged as working focus support. See that branch's
  `docs/TERMINAL_FOCUS_WIP.md`.

The original checkout and its dirty files remain intact. The publication
worktree is `../claude-emote-github-20261002`.

## Verification performed

Environment: Windows x64, Node 24.19.0, Claude Code 2.1.287.

| Check | Result |
| --- | --- |
| Host and desktop TypeScript | Passed |
| Full test suite, Vitest 4.1.11 | 606 tests passed in 55 files |
| Immutable upstream snapshot | 140 files verified |
| Strict plugin validation | Passed, both source and installed package |
| Lifecycle package and unrelated-directory install | Passed |
| Installed launcher, hook host, ASCII frames, privacy, cleanup | Passed with fake Claude processes |
| Packaged native WebView startup | Passed; real first-frame decode and live-stream readiness |
| Native synthetic lifecycle smoke | 11 events passed, five-field privacy boundary and process cleanup passed |
| Native screenshots | Ready and thinking captured and inspected |
| Native pause and next-pose controls | Passed |
| Browser rendering of the actual demo UI | All nine poses loaded without a fatal UI state; gallery and 45-frame GIF captured |
| Runtime dependency audit | Zero findings |
| Full dependency audit | Two moderate development-tool findings: Neutralino CLI and its uuid dependency |

No Claude model requests were made. `claude --version` and strict plugin
validation were the only real Claude CLI operations. Packaged launcher tests
used fake Claude executables. Synthetic events prove local rendering and
protocol behavior, not current stable/latest Claude end-to-end compatibility.

## Remaining acceptance work

1. Native dragging: two automated drag gestures did not change the reported
   window origin. The cause is unresolved; do not claim a verified drag pass.
   Test with a real pointer before changing the native drag implementation.
2. Repeat a short authenticated Claude session against supported stable/latest
   channels, including permissions, compaction, failure, and shutdown.
3. Recheck desktop scaling and persistence across displays at 125% and 150%.
4. Installer, signing, tray, auto-update, and multi-session management remain
   unimplemented. The npm package is still private and unpublished.
5. Repair exact terminal focus separately; the current WIP is unsafe to advertise.

## Repeatable checks without Claude quota

```powershell
npm ci
npm run typecheck
npm run overlay:typecheck
npm test
npm run verify:upstream
npm run validate:plugin
npm run validate:package
node scripts/smoke-native-overlay.mjs
npm run audit:runtime
```

Run package validation in a disposable/clean worktree: it removes and rebuilds
generated `dist/`, packages the native overlay, and creates temporary installs.
The native smoke opens a real pet for a few seconds and closes its owned
processes. It does not start Claude. Visual steps are in `VISUALS.md`.
