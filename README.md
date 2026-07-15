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

## Status

V1 is feature-complete against the original specification. See
[INTEGRATION_RESULTS.md](docs/INTEGRATION_RESULTS.md) for measured
performance and per-event results.

- 70 automated tests pass (functional + integration + mapper + bridge + server)
- Server processing p95: **13.7 ms** (target: 300 ms — 20× headroom)
- All Claude Code lifecycle events supported
- ASCII + Sixel (via Chafa) rendering

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
npm install
npm run build
```

```powershell
# globally (once published)
npm install -g claude-emote
```

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
# Run the full test suite
npm test

# Run the bridge benchmark
npm run benchmark:bridge

# Run the end-to-end latency sweep
node scripts\measure-latency.mjs

# Confirm the vendored pi-emote snapshot is unmodified
npm run verify:upstream
```

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

This is by design during the 500 ms orphan-detection grace period.
After 500 ms the parent-PID watcher closes the HTTP server and
shuts down. If a process persists longer, send `taskkill /F /PID <pid>`.

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
- The bridge is a Node.js process. On Windows, the OS-level spawn
  cost (~80-150 ms) is outside our control and pushes total
  wall-clock past the 50 ms p50 target. The bridge's own JS runs
  in 15-30 ms; on Linux/macOS the same path meets the target
  comfortably.
- Sixel rendering requires Chafa and a Sixel-capable terminal.
- We do not detect hidden reasoning tokens. `think` is inferred
  from lifecycle events only.

## Uninstall

```powershell
# Remove the global command
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
