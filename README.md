# claude-emote

Animated pixel-art avatar for Claude Code. Ports the proven
[pi-emote](https://github.com/JarodMica/jarods-pi-extensions)
animation engine and replaces Pi lifecycle events with Claude Code
hooks.

```
┌─────────────────────────────────────────┬──────────┐
│              Claude Code                │  Avatar  │
│                                         │          │
│  > tell me about this repo              │  (◕‿◕)   │
│  ◂ reading files...                     │  read    │
│  ◂ editing src/foo.ts                   │  write   │
│  ◂ running tests...                     │  tool    │
│  ◂ The test suite passes!               │  talk    │
│                                         │          │
└─────────────────────────────────────────┴──────────┘
```

## Status (Phase 9B)

What is **automatically validated** today:

- Phase 9A: clean-checkout validation,
  `claude plugin validate . --strict`,
  `npm run verify:upstream`,
  `npm run validate:package`,
  the bundled ASCII production path, and bundled image-asset
  compatibility — all passed on the same source tree.
- Phase 9B: `npm run benchmark:latency` measures the local
  production path — real compiled hook bridge, real compiled
  avatar process, real event mapper, real copied Animator,
  real ASCII renderer, real StandaloneRenderHost — through
  four distinct metrics:
  A. hook-bridge delivery
  B. direct avatar event-to-frame
  C. full hook-bridge-to-avatar-frame
  D. hook-bridge fail-open against an unavailable endpoint
  Full numbers live in
  [`docs/BENCHMARK_RESULTS.md`](docs/BENCHMARK_RESULTS.md)
  with raw samples in
  [`docs/benchmarks/phase9b-raw.json`](docs/benchmarks/phase9b-raw.json).
  The numbers apply to one machine on one date; they are
  not universal results.

**Phase 9B latency summary** (measured on one machine on 2026-07-18,
source commit `7c2cc94`):

| Metric | p50 | p95 | max |
| ------ | --- | --- | --- |
| full hook → ASCII stdout frame | 77.88 ms | 93.53 ms | 123.76 ms |
| direct event → ASCII stdout frame | 15.59 ms | 16.29 ms | 20.07 ms |
| bridge spawn → server receive | 48.71 ms | 60.86 ms | 88.40 ms |
| unavailable-avatar fail-open exit | 52.68 ms | 70.79 ms | 80.66 ms |

Measurements stop at avatar stdout. Real Claude hook-emission
timing and real Windows Terminal compositor/display timing are not
measured; Sixel rendering is not measured. Full results are in
[`docs/BENCHMARK_RESULTS.md`](docs/BENCHMARK_RESULTS.md) with raw
samples in
[`docs/benchmarks/phase9b-raw.json`](docs/benchmarks/phase9b-raw.json).
These numbers apply to one machine on one date and are not
universal results.

What is **not yet validated** and remains pending:

- Real interactive Windows Terminal visual validation (a human
  on Windows 10/11, inside an actual Windows Terminal pane, must
  confirm the avatar appears, animates, and reacts).
- Real Claude hook emission latency. The benchmark stops at the
  boundary where Claude Code would hand the event to the bridge;
  the time Claude itself takes before firing a hook is outside
  this measurement.
- Real Windows Terminal drawing latency (cursor-home erase +
  redraw under the actual WT scheduler) is outside this
  measurement.
- npm publish flow. The package tarball is validated but no
  registry is contacted.

The total automated test count is reported by `npm test` itself;
this README does not hardcode a number that can drift.

## Status (Phase 10)

Phase 10 is the Windows Terminal discovery and renderer-startup
closeout. It does not change the runtime architecture beyond
making the launcher resolve the modern Windows Terminal AppX
execution alias and giving the avatar process a graceful
bundled-ASCII startup retry. Full numbers from the prior
benchmark still live in
[`docs/BENCHMARK_RESULTS.md`](docs/BENCHMARK_RESULTS.md).

## Status (Phase 10.1)

Phase 10.1 is a narrow repair for the corrupted-output pattern
observed in the real Windows Terminal pane: the narrow right pane
was displaying the fallback warning, the `CLAUDE_EMOTE_READY`
marker, and long installed-package paths before the renderer
could take ownership. Because those lines are wrap-prone in a
25%-width pane and the renderer only repaints over its own frame
row count, the cursor-relative redraw eventually overlapped the
wrapped startup text, producing merged output like
`(• ◡ •)enderer could not pr...`.

Phase 10.1 introduces an explicit **visual-pane output mode** that
the launcher activates only for the WT pane child:

- The launcher passes `CLAUDE_EMOTE_VISUAL_PANE=1` to the WT pane
  child only. It is not added to Claude's environment; it is not
  set for the attached or test branches; the split-pane argv is
  unchanged.
- In visual-pane mode the avatar's output policy suppresses every
  non-frame operational line — READY, fallback warning, debug
  diagnostics, avatar-server event logs, port / instance /
  emote-directory messages — from stdout / stderr. The pane is
  treated as an exclusive render area.
- Before the first frame, the renderer emits exactly one
  `\x1b[2J\x1b[H` clear-pane + cursor-home sequence. Subsequent
  redraws use the normal erase-N-lines path; the renderer owns the
  frame area from then on.
- Readiness is observed exclusively through `/health`, which the
  launcher already polls. The READY marker is not consumed by the
  launcher in any mode; this was always an external convenience.
- When `CLAUDE_EMOTE_LOG_FILE` is configured, suppressed
  diagnostics still land in the log file so operators can debug a
  real Windows Terminal run without paying the visual-corruption
  cost.
- Attached / test / validation modes retain their full diagnostic
  output — READY on stdout, the fallback warning on stderr,
  installed paths on the READY line. The new contract is opt-in.
- Fatal startup errors in visual-pane mode may still print one
  concise line because no usable renderer exists in that case.

Phase 10.1 does not change the Phase 9B benchmark values. The
benchmark targets the avatar stdout frame boundary and the
attached-mode output paths; visual-pane mode suppresses bytes
the benchmark never measures. Full results still live in
[`docs/BENCHMARK_RESULTS.md`](docs/BENCHMARK_RESULTS.md).

### What still requires real-machine validation

- Real interactive Windows Terminal visual validation must be
  rerun after this fix. The automated tests prove the output
  policy, the launcher environment wiring, the surface
  initialization, and the installed-package smoke; a human on
  Windows 10/11 inside an actual Windows Terminal pane must
  confirm the avatar now appears cleanly, without the merged
  `(• ◡ •)enderer could not pr...` corruption pattern.

### Windows Terminal discovery

Windows Terminal discovery now supports the AppX execution
alias at:

```
%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe
```

Resolution order is, top to bottom:

1. `CLAUDE_EMOTE_WT_EXE` (explicit override)
2. The canonical WindowsApps alias
   (`%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe`)
3. `where.exe wt.exe` output
4. `PATH` scan

The resolver uses no `shell: true`, no `cmd /c`, no `start`, no
PowerShell helper, and no detached process. Spawning is a direct
`child_process.spawn` of the resolved executable. The shell-free
spawn path is the contract; do not "helpfully" wrap it in a
shell later.

### Renderer startup

- **Chafa is optional for basic operation.** When Chafa is
  missing, not executable, or not Sixel-capable, the avatar falls
  back to the bundled ASCII renderer and continues to run; no
  startup failure.
- **Automatic bundled-image startup retries once.** When the
  preferred renderer cannot produce its initial frame, the
  startup sequence retries exactly once with the bundled
  `AsciiRenderer` and the `emotes/ascii` emote set. This retry is
  internal to the startup path and only fires for the auto-chosen
  configuration.
- **Explicit custom emote directories never silently fall back to
  bundled artwork.** When the user has explicitly pointed the
  launcher at a custom emote directory (via `CLAUDE_EMOTE_EMOTE_DIR`
  or an explicit `config.json` setting), startup failures surface
  to the user; bundled ASCII is reserved for the implicit, no-user-
  choice case.
- **The fallback stays in the same avatar process and keeps the
  same port, instance ID, parent PID, and HTTP server lifecycle.**
  A fallback does not spawn a second avatar, does not rebind the
  port, does not regenerate the instance ID, and does not close or
  reopen the HTTP server. The HTTP listener and parent-PID watcher
  remain continuous across the retry.

### What is still pending

- **Real interactive Windows Terminal visual validation.** A human
  on Windows 10/11, inside an actual Windows Terminal pane, must
  confirm the avatar appears, animates, and reacts. This step has
  not yet been rerun against the Phase 10 build and remains pending.

## What it is

`claude-emote` runs an animated pixel-art avatar in a narrow
Windows Terminal pane next to Claude Code. The avatar reacts to
Claude Code's lifecycle events (prompt submitted, tool running,
streaming response, etc.) with no AI or model call in the loop —
state decisions are made by a tiny mapper in
[`src/claude/event-mapper.ts`](src/claude/event-mapper.ts).

## What it isn't

- Not a custom Claude Code TUI
- Not a chat application or LLM wrapper
- Not a generic "AI companion"
- Not Linux/macOS compatible (V1 is Windows Terminal only; ASCII
  fallback works on any TTY but the pane splitting is WT-specific)

## Quick start

### Prerequisites

- Windows 10 or 11
- [Node.js](https://nodejs.org/) 20.18.1+ (or 22.x)
- [Claude Code](https://docs.claude.com/claude-code) installed and on `PATH`
- [Windows Terminal](https://aka.ms/terminal) installed
- Optional: [Chafa](https://hpjansson.org/chafa/) for Sixel rendering

### Install

```powershell
# from this repo (development)
git clone <this-repo> claude-emote
cd claude-emote
npm ci
```

The `pretest` script automatically builds the dist artifacts on
`npm test`. For a manual build (e.g. before running the launcher
directly), use `npm run build`.

For a packaged install (locally produced tarball, no registry
involved), use `npm run validate:package` — the script
demonstrates the full flow end-to-end.

### Run

```powershell
# Start Claude Code with the avatar pane
claude-emote

# Forward arbitrary Claude flags
claude-emote --resume
claude-emote --model opus
claude-emote --dangerously-skip-permissions

# Run the standalone demo (no Claude required)
npm run demo

# Force a specific renderer
$env:CLAUDE_EMOTE_DEMO_PROTOCOL="ascii"  # or "sixel"
npm run demo
```

### Verify

```powershell
# Run the full test suite (pretest builds dist automatically).
npm test

# Confirm the vendored pi-emote snapshot is unmodified.
npm run verify:upstream

# Validate the Claude plugin manifest strictly.
npm run validate:plugin

# Pack, install in an unrelated temp dir, run smoke tests.
npm run validate:package
```

The following scripts remain in the repository for developer
ergonomics but are NOT part of the package's automated validation
in Phase 9B:

- `npm run demo` — interactive state demo.

## How it works

Claude Code fires a hook for every supported lifecycle event. The
hook command (defined in [`hooks/hooks.json`](hooks/hooks.json))
spawns the bridge executable at
`dist/claude/hook-bridge.js`. The bridge:

1. Reads the complete hook JSON from stdin.
2. Reads `CLAUDE_EMOTE_ENDPOINT` from the environment.
3. POSTs the unmodified JSON to the local avatar server.
4. Exits 0 — never blocks Claude.

The avatar server (`dist/host/avatar-process.js`) listens on
`127.0.0.1:<random-port>`, applies the event mapper, and drives the
copied pi-emote Animator. The Animator updates the selected Renderer
(ASCII or Sixel), and the StandaloneRenderHost writes the new frame
at the pane's home position with ghost-prevention erasure.

Full architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
State mapping rules: [`docs/STATE_MACHINE.md`](docs/STATE_MACHINE.md).
Hook protocol contract: [`docs/HOOK_PROTOCOL.md`](docs/HOOK_PROTOCOL.md).
Source map (every file's provenance): [`docs/SOURCE_MAP.md`](docs/SOURCE_MAP.md).

## Configuration

`config.json` is the same as the upstream pi-emote config. The
launcher also honours these environment variables:

| Variable | Purpose |
| -------- | ------- |
| `CLAUDE_EMOTE_INSTANCE_ID` | Random per-launch ID, set by launcher. |
| `CLAUDE_EMOTE_ENDPOINT` | Avatar server URL, set by launcher. |
| `CLAUDE_EMOTE_PARENT_PID` | PID of the launcher, watched for orphan detection. |
| `CLAUDE_EMOTE_DEBUG=1` | Verbose stderr logging. |
| `CLAUDE_EMOTE_CHAFA_PATH` | Path to `chafa.exe` for Sixel rendering. |
| `CLAUDE_EMOTE_EMOTE_DIR` | Override the emote-set directory. |
| `CLAUDE_EMOTE_DATA_DIR` | Override the per-user data dir (default `~/.claude-emote`). |
| `CLAUDE_EMOTE_LOG_FILE` | Optional persistent log path; suppressed visual-pane diagnostics still land here. |
| `CLAUDE_EMOTE_VISUAL_PANE` | Set to `1` only for the WT pane child; suppresses non-frame output and switches readiness to `/health`. |
| `PI_EMOTE_CHAFA_PATH` | Backwards-compatible Chafa path (V1 also reads this). |
| `WT_SESSION` | Set by Windows Terminal; the launcher reads it to confirm pane mode. |

## Custom emote import

The upstream pi-emote importer (`src/core/importer.ts`) loads emote
sets from:

1. `<project>/.claude-emote/extensions/claude-emote/emotes/<set>/`
2. `<user-data>/extensions/claude-emote/emotes/<set>/`
3. `<extension>/emotes/<set>/` (built-in defaults)

To use a custom set, drop a folder under one of those locations and
set `"emotes": [{ "model": "*", "emote-set": "<your-set>" }]` in
`config.json`. The folder layout must match the upstream format
(see `vendor/pi-emote-original/emotes/ascii/ascii.yaml` for the ASCII
schema, or `vendor/pi-emote-original/emotes/default/` for the image
schema).

No conversion is required — the importer reads both PNG and YAML
formats directly from the upstream.

## Plugin development

To iterate on the plugin manifest or hooks without rebuilding:

```powershell
# Symlink the plugin into your Claude Code plugins directory
$env:CLAUDE_PLUGINS="$env:USERPROFILE\.claude\plugins"
New-Item -ItemType Junction -Path "$env:CLAUDE_PLUGINS\claude-emote" `
  -Target (Resolve-Path .)
```

For local development without symlinks, point Claude Code at the
absolute path of the compiled bridge in
[`hooks/hooks.json`](hooks/hooks.json).

## Troubleshooting

### "claude not found on PATH"

Install [Claude Code](https://docs.claude.com/claude-code) and make
sure `claude` is on `PATH`. From a normal `cmd.exe` window:
`where claude` should resolve.

### Avatar pane doesn't appear

Check that you're running inside Windows Terminal (the launcher
checks `WT_SESSION`). If you ran `claude-emote` from `cmd.exe`
inside a legacy console, the avatar falls back to a separate
console window — that's expected.

### Avatar is monochrome / text-only

The avatar is using ASCII because Sixel rendering isn't available.
Verify:

```powershell
where.exe chafa          # should resolve to chafa.exe
$env:CLAUDE_EMOTE_CHAFA_PATH = "C:\path\to\chafa.exe"  # if not on PATH
```

Windows Terminal must also allow Sixel graphics. Recent versions
expose this in Settings → Profile → Advanced → "Enable Sixel".

### Avatar process is still running after Claude exits

This is by design during the orphan-detection grace period. The
parent-PID watcher closes the HTTP server and shuts the avatar
down once the launcher exits. If a process persists longer, send
`taskkill /F /PID <pid>`.

### Tests fail with "verify-upstream: 1 mismatch(es)"

The vendored snapshot was modified. Re-record with:

```powershell
node scripts\verify-upstream.mjs --record
```

…and review the diff carefully before committing. The snapshot must
only be re-recorded after intentionally pulling a new upstream
commit.

## Limitations

- V1 only works on Windows 10/11 inside Windows Terminal. Linux and
  macOS get the ASCII renderer as a fallback, but no pane splitting.
- The avatar pane is separate from Claude Code's TUI because Claude
  Code does not expose an arbitrary embedded widget slot. This is
  not a workaround — it is the architectural choice the spec made.
- The benchmark measures the local production path end to end at
  the stdout frame boundary. Real Claude hook emission latency and
  real Windows Terminal redraw scheduling are not part of the
  measurement; numbers apply to one machine on one date.
- Sixel rendering requires Chafa and a Sixel-capable terminal.
- We do not detect hidden reasoning tokens. `think` is inferred
  from lifecycle events only.

## Uninstall

```powershell
# Remove the global command (only relevant if you installed via npm)
npm uninstall -g claude-emote

# Remove local dev checkout
Remove-Item -Recurse -Force .\claude-emote

# Remove user config
Remove-Item -Recurse -Force $env:USERPROFILE\.claude-emote

# Remove the Claude Code plugin link (if you created one)
Remove-Item -Recurse -Force "$env:USERPROFILE\.claude\plugins\claude-emote"

# Remove from your project (if you configured per-project hooks)
# Edit .claude/settings.json or your project's hooks config.
```

## Licence

MIT. See [`LICENSE`](LICENSE). The vendored pi-emote snapshot
retains its original MIT licence; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for attribution.
