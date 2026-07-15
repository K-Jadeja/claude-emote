# Architecture

## High-level

```
┌──────────────────────────────┐        ┌──────────────────────────────┐
│       Windows Terminal       │        │       Windows Terminal       │
│  ┌────────────────────────┐  │        │  ┌────────────────────────┐  │
│  │      Claude Code       │  │        │  │    claude-emote pane   │  │
│  │                        │  │        │  │                        │  │
│  │  stdin  ◀──── hook 1   │  │        │  │  avatar server         │  │
│  │  stdin  ◀──── hook 2   │  │        │  │  (127.0.0.1:port)      │  │
│  │  ...                   │  │        │  │                        │  │
│  │                        │  │        │  │  Animator              │  │
│  │                        │  │        │  │   │                    │  │
│  │                        │  │        │  │   ▼                    │  │
│  └─────────┬──────────────┘  │        │  │  Renderer              │  │
│            │                 │        │  │   │                    │  │
│            │ /event          │        │  │   ▼                    │  │
│            │ POST            │        │  │  StandaloneRenderHost  │  │
│            │                 │        │  │   │                    │  │
│            │                 │        │  │   ▼                    │  │
│            │                 │        │  │  terminal pane         │  │
│            │                 │        │  └────────────────────────┘  │
└────────────┼─────────────────┘        └──────────────────────────────┘
             │
             │ spawn (fork+exec)
             ▼
   bridge.js (one per hook event)
   - reads stdin
   - reads CLAUDE_EMOTE_ENDPOINT
   - POSTs unmodified JSON
   - exits 0
```

## Components

| Layer | Path | Purpose |
| ----- | ---- | ------- |
| **Plugin manifest** | `.claude-plugin/plugin.json` | Claude Code plugin descriptor. |
| **Hooks** | `hooks/hooks.json` | One entry per supported Claude Code event, all pointing at the same bridge. |
| **Bridge** | `src/claude/hook-bridge.ts` → `dist/claude/hook-bridge.js` | Node-stdlib-only process. Reads stdin, POSTs to `CLAUDE_EMOTE_ENDPOINT`, exits 0. |
| **Server** | `src/host/avatar-server.ts` | HTTP server bound to `127.0.0.1`. Accepts `/event` and `/health`. Rejects oversized bodies. |
| **Process** | `src/host/avatar-process.ts` | The standalone avatar process. Owns one Animator + one Renderer + one StandaloneRenderHost. |
| **Mapper** | `src/claude/event-mapper.ts` | Single source of truth: Claude event → avatar state (+ optional talk token). |
| **Core** | `src/core/*` (ported) | The copied pi-emote animation engine: Animator, Renderer, Emotes, Importer, etc. |
| **Host adapter** | `src/adapters/standalone-render-host.ts` | Satisfies the `Renderer.setTui({requestRender()})` contract with debounced, home-positioned redraws. |
| **Renderer factory** | `src/adapters/renderer-factory.ts` | Picks a concrete Renderer class (ASCII, Sixel, Kitty, iTerm2, WezTerm, tmux variants) based on terminal capability. |
| **Terminal I/O** | `src/adapters/terminal-output.ts` | Cursor control primitives (hide/show, save/restore, home, erase). |
| **Launcher** | `src/launcher/claude-emote.ts` | The `claude-emote` CLI. Spawns the avatar pane, sets env, runs `claude`, forwards exit code. |
| **Bin shim** | `bin/claude-emote.cjs` | CJS entry point that loads the compiled launcher. Lets `npm install -g` wire up the `claude-emote` command. |
| **Vendor** | `vendor/pi-emote-original/` | Immutable copy of the upstream pi-emote snapshot at the pinned commit. |

## Data flow

1. Claude Code fires a hook.
2. The hook command (defined in `hooks/hooks.json`) runs `node dist/claude/hook-bridge.js`.
3. The bridge reads the full hook JSON from stdin, reads `CLAUDE_EMOTE_ENDPOINT` from the environment, and POSTs the unmodified JSON to the avatar server.
4. The avatar server applies `mapEvent()` to produce an `AvatarReaction`.
5. The server calls `animator.transitionTo(state)` for state changes, or `animator.onTalkToken(text)` for `MessageDisplay` deltas.
6. The Animator drives the selected Renderer.
7. The Renderer updates its current frame and calls `tuiRef.requestRender()`.
8. The StandaloneRenderHost debounces, repositions the cursor to the pane home, erases prior lines, and writes the new frame.
9. The avatar process cleans up on `SessionEnd`, on parent disappearance, or on signal.

## Boundary contracts

| Boundary | Contract | Enforcement |
| -------- | -------- | ----------- |
| Bridge → Server | POST `/event` with unmodified JSON body | `tests/integration/hook-bridge.test.ts` |
| Server → Animator | `mapEvent()` output → `transitionTo` / `onTalkToken` | `tests/integration/avatar-server.test.ts`, `tests/unit/event-mapper.test.ts` |
| Renderer → Standalone host | `setTui({requestRender()})` | `tests/unit/standalone-render-host.test.ts` |
| Standalone host → Terminal pane | `cursorHome` + `eraseLines(N)` + lines with `\r\n` | standalone host redraw tests |
| Launcher → `claude` | `spawn(claude, args, env)` with passthrough args | manual / `docs/INTEGRATION_RESULTS.md` |

## What is NOT here

- No custom Claude Code TUI
- No AI / LLM call in the avatar pipeline
- No parsing of Claude's terminal output
- No Electron, Tauri, Ink, or other UI framework
- No Pi runtime dependency
- No cloud, telemetry, or update services
- No chat / voice / Live2D / character generation
- No terminal emulator or PTY compositor
