# Development

## Prerequisites

- Node.js 20 or newer.
- npm 10 or newer.
- Windows 10/11 with the WebView2 runtime for the current desktop slice.

No Rust, Go, .NET SDK, Electron, global TypeScript install, or cloud account is
required.

## First setup

```powershell
npm install
npm run typecheck
npm test
npm run overlay:package
```

The normal TypeScript build writes `dist/`. The desktop web build writes
`desktop/resources/`, and packaging writes `desktop/dist/`. All three
directories are generated.

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile the Node host and terminal renderer |
| `npm run typecheck` | Check TypeScript without writing output |
| `npm run test:unit` | Run pure and small-scope tests |
| `npm run test:integration` | Run process and HTTP boundary tests |
| `npm test` | Build and run the complete suite |
| `npm run demo` | Cycle all states in the terminal renderer |
| `npm run overlay:build` | Build the desktop web resources |
| `npm run overlay:run` | Build and launch the native overlay |
| `npm run overlay:package` | Produce platform binaries |

## Safe workflow for a behavior change

1. Identify the owning module from `AGENTS.md` and `docs/SOURCE_MAP.md`.
2. Reproduce the exact failure.
3. Add a regression test that fails for the right reason.
4. Fix the root cause.
5. Run the focused test, `npm run typecheck`, and the full suite.
6. If visible behavior changed, run the relevant terminal or desktop demo.
7. Add an incident note when the root cause or workflow is likely to recur.

## Desktop overlay workflow

Run:

```powershell
npm run overlay:run
```

`npm run overlay:run` starts in demo mode and cycles every available pose.
Drag the pet to verify native window movement. Close it from the hover controls
or terminate the command with Ctrl+C.

The view can be tested without a native window because state-to-frame mapping is
pure and the shell adapter has a browser implementation.

On Windows, verify once at 100% and once at 125% or 150% display scaling. The
shell expands the physical window by `devicePixelRatio` so the 272 by 324 CSS
design surface remains complete.

For a production-shaped live run, first package the overlay and link the
checkout, then run `claude-emote --resume`. The launcher owns the endpoint and
capability; do not copy them into URLs. Protocol details are in
`docs/DESKTOP_SESSION_PROTOCOL.md`.

## Test isolation

Terminal capability tests must pass their intended terminal name explicitly.
Do not let `WT_SESSION`, `TERM_PROGRAM`, or another developer-shell variable
silently determine a unit-test result.

Process cleanup tests should wait for the documented cleanup deadline instead
of assuming a child has disappeared in the same scheduler tick.

## Troubleshooting

### Overlay opens as an opaque rectangle

Confirm WebView2 is current and that `modes.window.transparent` is enabled in
`desktop/neutralino.config.json`. Transparent mode intentionally makes the
window borderless.

### Overlay build reports a missing frame

Restore the named file or correct the frame map. Missing semantic poses are
fatal by design; the build does not substitute another activity.

### Terminal demo scrolls or crashes

Run the focused demo integration test, then consult
`docs/incidents/2026-07-27-demo-frame-source-recursion.md`.

### Native binary is missing

Run `npm run overlay:setup` once to fetch the pinned Neutralino runtime, then
retry `npm run overlay:run`.
