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
| `NEW_UI`           | New desktop UI or native-shell file; not derived from upstream.  |
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
| `src/core/terminal.ts`            | `COPIED_PATCHED` | `extensions/pi-emote/src/terminal.ts`            | Import paths adjusted; terminal detection can be injected explicitly so tests do not inherit the developer shell. Runtime defaults remain upstream-compatible. |
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
| `src/host/avatar-server.ts`              | `NEW_ADAPTER` | Capability-protected hook/state/SSE/readiness server bound to 127.0.0.1. |
| `src/host/avatar-process.ts`             | `NEW_ADAPTER` | Owns one `Animator` and the selected renderer; cleans up on signal/exit. |
| `src/host/session-auth.ts`               | `NEW_ADAPTER` | Constant-time bearer-capability verification. |
| `src/host/session-host-process.ts`       | `NEW_ADAPTER` | Renderer-free semantic host for native desktop sessions. |
| `src/host/avatar-args.ts`                | `NEW_ADAPTER` | Validates avatar-process command-line arguments. |
| `src/host/avatar-state-controller.ts`    | `NEW_ADAPTER` | Applies state priority while synchronizing timed Animator transitions. |
| `src/host/output-policy.ts`              | `NEW_ADAPTER` | Separates visual-pane output from diagnostic logging. |
| `src/host/pet-session-state-tracker.ts`  | `NEW_ADAPTER` | Converts accepted reactions into the five-field desktop state without retaining raw content. |
| `src/host/renderer-startup.ts`           | `NEW_ADAPTER` | Performs bounded renderer startup and permitted bundled-ASCII recovery. |
| `src/host/runtime-config.ts`              | `NEW_ADAPTER` | Resolves layered runtime configuration and explicit user choices. |
| `src/launcher/args.ts`                   | `NEW_ADAPTER` | Pure wrapper parsing plus Claude, host, and terminal argument construction. |
| `src/launcher/claude-emote.ts`           | `NEW_ADAPTER` | CLI entry point and supervised desktop/terminal/none lifecycle. |
| `src/launcher/desktop-overlay.ts`        | `NEW_ADAPTER` | Resolves packaged/dev native runtimes and builds secret-free spawn arguments. |
| `src/launcher/startup.ts`                | `NEW_ADAPTER` | Import-safe process readiness and owned-child cleanup helpers. |

### `src/shared/`

| File | Status | Notes |
| --- | --- | --- |
| `src/shared/emote-selection.ts` | `NEW_ADAPTER` | Chooses bundled or explicitly configured artwork without hiding user-owned failures. |
| `src/shared/emote-validation.ts` | `NEW_ADAPTER` | Validates emote directories and required assets. |
| `src/shared/pet-session-state.ts` | `NEW_ADAPTER` | Defines and strictly validates the privacy-minimal desktop protocol. |
| `src/shared/project-paths.ts` | `NEW_ADAPTER` | Resolves package paths consistently in source, build, and installed layouts. |
| `src/shared/session-capability.ts` | `NEW_ADAPTER` | Shared validation and authorization-header construction for per-session tokens. |

### `desktop/`

All desktop files are new work for `claude-emote`; none are copied from
Neutralinojs or Codex.

| File | Status | Notes |
| --- | --- | --- |
| `desktop/asset-manifest.json` | `NEW_UI` | Declares every required pose and its attributed local frames. |
| `desktop/neutralino.config.json` | `NEW_UI` | Defines the transparent, borderless, always-on-top native window and build resources. |
| `desktop/tsconfig.json` | `NEW_UI` | Isolated browser TypeScript configuration. |
| `desktop/src/index.html` | `NEW_UI` | Accessible document shell and controls. |
| `desktop/src/styles.css` | `NEW_UI` | Pixel-art visual system, status cues, responsive bounds, and reduced-motion behavior. |
| `desktop/src/main.ts` | `NEW_UI` | Small composition root for demo or live mode. |
| `desktop/src/demo-controller.ts` | `NEW_UI` | Deterministic developer-preview state cycle. |
| `desktop/src/pet-state.ts` | `NEW_UI` | Pure state, labels, and frame selection. |
| `desktop/src/pet-view.ts` | `NEW_UI` | DOM renderer and local frame animation. |
| `desktop/src/pointer-guard.ts` | `NEW_UI` | Prevents controls from initiating native window dragging. |
| `desktop/src/session-stream-client.ts` | `NEW_UI` | Authenticated streaming-fetch SSE client with strict validation and sequence ordering. |
| `desktop/src/shell.ts` | `NEW_UI` | Neutralino/browser boundary for window behavior, environment reads, and position persistence. |

### Upstream files NOT ported

| File                          | Status        | Reason |
| ----------------------------- | ------------- | ------ |
| `vendor/pi-emote-original/index.ts`     | `NOT_PORTED` | Pi extension entry point; Pi lifecycle wiring, not applicable. Behavioural reference only. |
| `vendor/pi-emote-original/src/widget.ts` | `NOT_PORTED` | Pi TUI widget integration; replaced by standalone avatar process. Behavioural reference only. |
| `vendor/pi-emote-original/src/menu.ts`   | `NOT_PORTED` | Pi menu integration. Behavioural reference only. |

### Vendor assets

| Path                  | Status           | Notes |
| --------------------- | ---------------- | ----- |
| `emotes/**`           | `COPIED_UNCHANGED` | Loaded by the terminal importer; selected attributed PNG frames are also copied into generated desktop resources. |
| `config.json`         | `COPIED_UNCHANGED` | Top-level configuration used by `config.ts`. |
| `LICENSE`             | `COPIED_UNCHANGED` | Identical to `LICENSE` at repo root. |
