# Desktop Overlay Architecture

Status: accepted for the first vertical slice on 2026-07-27.

## Decision

Use Neutralinojs for the first native overlay and keep all product behavior in
framework-free TypeScript.

Neutralino uses the operating system WebView instead of bundling Chromium. It
supports a transparent, borderless, always-on-top window and exposes the small
window API this product needs. The native dependency stays behind
`desktop/src/shell.ts`, so the UI can run in an ordinary browser for tests and
can move to another shell later.

## Why not Electron

Electron is mature and capable, but its bundled Chromium and Node runtime are
disproportionate for a pet that renders a few local PNG frames and consumes a
local semantic event stream. Startup time, memory, package size, and update
surface all work against this product's lightweight promise.

## Why not Tauri yet

Tauri is the strongest likely long-term alternative. It has a small system
WebView architecture and a mature packaging story, but it introduces Rust and a
native build toolchain that this repository and current development environment
do not have. The shell boundary lets us reconsider Tauri when tray behavior,
signed auto-updates, or distribution requirements justify that cost.

## Why not Wails

Wails is viable and the current environment has Go, but it introduces a second
application language and native backend for behavior already served by the
Node process. Neutralino adds less code and fewer concepts for the first slice.

## Runtime boundaries

```text
Claude Code hook
      |
      | event JSON over localhost
      v
Node session host
  - validates the hook
  - maps it to semantic state
  - owns timers and current snapshot
      |
      | GET /state + SSE /stream
      | snapshot + semantic events only
      v
Desktop UI
  - maps state to local asset frames
  - animates and labels the pet
  - persists window position
      |
      v
Neutralino shell adapter
  - transparent window
  - always on top
  - drag, position, close
```

The overlay protocol must not include prompt content, completion content, tool
arguments, tool results, or environment variables.

## Source layout

```text
desktop/
  neutralino.config.json  Native window and resource configuration
  src/
    index.html            Accessible DOM shell
    main.ts               Composition root
    pet-state.ts          Pure state and frame selection
    pet-view.ts           DOM rendering and animation
    shell.ts              Native/browser shell boundary
    styles.css            Visual system and motion
  resources/              Generated web resources; ignored
  dist/                   Packaged application output; ignored
```

Do not place application rules in `main.ts` or native API calls in view
modules. `pet-state.ts` must be unit-testable in Node.

## Initial state contract

```ts
type SessionStatus =
  | "running"
  | "needs-input"
  | "ready"
  | "blocked"
  | "ended"
  | "disconnected";

type Activity =
  | "greeting"
  | "idle"
  | "thinking"
  | "reading"
  | "writing"
  | "tooling"
  | "talking"
  | "compacting"
  | "failure";
```

Each update carries a monotonically increasing sequence number, a session ID,
the status, the activity, and a timestamp. Reconnect starts with an SSE
`snapshot` event. Clients ignore older sequence numbers. The complete wire
contract is documented in `docs/DESKTOP_SESSION_PROTOCOL.md`.

## Asset policy

The first slice uses the existing `emotes/default` frames, which are attributed
to the MIT-licensed pi-emote project in `THIRD_PARTY_NOTICES.md`. Asset paths
are declared in one manifest-like map. New packs must include license,
attribution, frame dimensions, and mappings for all required activities.

## Failure behavior

- If the shell cannot initialize, show a clear diagnostic and exit non-zero.
- If an asset is missing, fail the build. Do not silently substitute a
  misleading pose.
- If the event connection drops, show `disconnected`; do not continue
  pretending Claude is working.
- If a malformed update arrives, reject it and retain the last valid state.
- Reconnection uses bounded exponential backoff and returns to the authoritative
  snapshot before displaying fresh activity.

## Security

The host binds only to `127.0.0.1`. Browser reads use restrictive loopback-only
CORS, and the state schema excludes session content. Before this becomes a
generally distributed multi-session daemon, add a per-session capability token
as a second local-process boundary.

## Revisit criteria

Evaluate Tauri before public packaging if we need two or more of:

- a tray menu with strong cross-platform behavior;
- signed background updates;
- a global shortcut;
- window click-through or advanced multi-monitor controls unavailable in the
  current Neutralino release;
- a packaged size or idle-memory target Neutralino cannot meet.
