# Source Map

This document lists every active source file in `claude-emote` together with
its provenance from upstream `pi-emote` (pinned commit
`3d2782bec7be5f11eb2a6422adb80b3f38d2974c`) or its status as new code.

## Status legend

| Status             | Meaning                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `COPIED_UNCHANGED` | Byte-for-byte copy from `vendor/pi-emote-original/`.            |
| `COPIED_PATCHED`   | Copied with documented boundary-level changes only.             |
| `NEW_ADAPTER`      | New file written for this port; not derived from upstream logic. |
| `NOT_PORTED`       | Not copied into active code; kept only in the vendor snapshot.  |

## Verification

`npm run verify:upstream` re-checks every `COPIED_UNCHANGED` and
`COPIED_PATCHED` file against the immutable vendor snapshot. Any drift
fails the script.

## Files

### `src/core/`

| File                | Status           | Upstream path                          | Notes |
| ------------------- | ---------------- | -------------------------------------- | ----- |
| `src/core/animator.ts`     | `COPIED_UNCHANGED` | `extensions/pi-emote/src/animator.ts`     | — |
| `src/core/renderer.ts`     | `COPIED_UNCHANGED` | `extensions/pi-emote/src/renderer.ts`     | — |
| `src/core/emotes.ts`       | `COPIED_UNCHANGED` | `extensions/pi-emote/src/emotes.ts`       | — |
| `src/core/importer.ts`     | `COPIED_UNCHANGED` | `extensions/pi-emote/src/importer.ts`     | — |
| `src/core/log.ts`          | `COPIED_UNCHANGED` | `extensions/pi-emote/src/log.ts`          | — |
| `src/core/tmux.ts`         | `COPIED_UNCHANGED` | `extensions/pi-emote/src/tmux.ts`         | — |
| `src/core/types.ts`        | `COPIED_UNCHANGED` | `extensions/pi-emote/src/types.ts`        | — |
| `src/core/render_image.ts`        | `COPIED_PATCHED` | `extensions/pi-emote/src/render_image.ts`        | Boundary-level: import paths adjusted to `src/core/*`; no logic changes. |
| `src/core/render_ascii.ts`        | `COPIED_PATCHED` | `extensions/pi-emote/src/render_ascii.ts`        | Boundary-level: import paths adjusted; no logic changes. |
| `src/core/render_kitty.ts`        | `COPIED_PATCHED` | `extensions/pi-emote/src/render_kitty.ts`        | Boundary-level: import paths adjusted; no logic changes. |
| `src/core/render_iterm.ts`        | `COPIED_PATCHED` | `extensions/pi-emote/src/render_iterm.ts`        | Boundary-level: import paths adjusted; no logic changes. |
| `src/core/render_wezterm_iterm.ts`| `COPIED_PATCHED` | `extensions/pi-emote/src/render_wezterm_iterm.ts`| Boundary-level: import paths adjusted; no logic changes. |
| `src/core/render_sixel.ts`        | `COPIED_PATCHED` | `extensions/pi-emote/src/render_sixel.ts`        | Pi-specific bits removed (dummy Kitty prefix, Pi widget cursor moves). Chafa invocation preserved. New env var `CLAUDE_EMOTE_CHAFA_PATH` added with `PI_EMOTE_CHAFA_PATH` fallback. See STATE_MACHINE.md and HOOK_PROTOCOL.md. |
| `src/core/render_tmux_iterm.ts`   | `COPIED_PATCHED` | `extensions/pi-emote/src/render_tmux_iterm.ts`   | Boundary-level: import paths adjusted; no logic changes. |
| `src/core/render_tmux_kitty.ts`   | `COPIED_PATCHED` | `extensions/pi-emote/src/render_tmux_kitty.ts`   | Boundary-level: import paths adjusted; no logic changes. |
| `src/core/render_tmux_kitty_unicode.ts` | `COPIED_PATCHED` | `extensions/pi-emote/src/render_tmux_kitty_unicode.ts` | Boundary-level: import paths adjusted; no logic changes. |
| `src/core/terminal.ts`            | `COPIED_PATCHED` | `extensions/pi-emote/src/terminal.ts`            | Boundary-level: import paths adjusted; no logic changes. |
| `src/core/config.ts`              | `COPIED_PATCHED` | `extensions/pi-emote/src/config.ts`              | Boundary-level: import paths adjusted; no logic changes. |
| `src/core/paths.ts`               | `COPIED_PATCHED` | `extensions/pi-emote/src/paths.ts`               | Boundary-level: import paths adjusted; no logic changes. |

### `src/adapters/`, `src/claude/`, `src/host/`, `src/launcher/`

| File                                | Status         | Notes |
| ----------------------------------- | -------------- | ----- |
| `src/adapters/standalone-render-host.ts` | `NEW_ADAPTER` | Standalone host that satisfies the `requestRender()` contract expected by copied renderer classes. |
| `src/adapters/renderer-factory.ts`       | `NEW_ADAPTER` | Selects an upstream renderer class based on terminal capability detection. |
| `src/adapters/terminal-output.ts`        | `NEW_ADAPTER` | Thin wrapper for the avatar pane: cursor home, hide/show cursor, redraw. |
| `src/claude/hook-event.ts`               | `NEW_ADAPTER` | Strongly-typed shape of every supported Claude Code hook event. |
| `src/claude/event-mapper.ts`             | `NEW_ADAPTER` | Single source of truth mapping Claude events to avatar states. |
| `src/claude/hook-bridge.ts`              | `NEW_ADAPTER` | Node-stdlib-only bridge that POSTs the event JSON to the avatar server. |
| `src/host/avatar-server.ts`              | `NEW_ADAPTER` | HTTP server bound to 127.0.0.1; accepts `/event`, exposes `/health`. |
| `src/host/avatar-process.ts`             | `NEW_ADAPTER` | Owns one `Animator` and the selected renderer; cleans up on signal/exit. |
| `src/launcher/claude-emote.ts`           | `NEW_ADAPTER` | CLI entry point: pane launch, health handshake, env propagation. |

### Upstream files NOT ported

| File                          | Status        | Reason |
| ----------------------------- | ------------- | ------ |
| `vendor/pi-emote-original/index.ts`     | `NOT_PORTED` | Pi extension entry point; Pi lifecycle wiring, not applicable. Behavioural reference only. |
| `vendor/pi-emote-original/src/widget.ts` | `NOT_PORTED` | Pi TUI widget integration; replaced by standalone avatar process. Behavioural reference only. |
| `vendor/pi-emote-original/src/menu.ts`   | `NOT_PORTED` | Pi menu integration. Behavioural reference only. |

### Vendor assets

| Path                  | Status           | Notes |
| --------------------- | ---------------- | ----- |
| `emotes/**`           | `COPIED_UNCHANGED` (planned for M1) | Loaded by importer with no conversion. |
| `config.json`         | `COPIED_UNCHANGED` (planned for M1) | Top-level configuration used by `config.ts`. |
| `LICENSE`             | `COPIED_UNCHANGED` | Identical to `LICENSE` at repo root. |
