# Claude Pet Product Vision

## One-sentence promise

Claude Pet is a lightweight desktop companion that makes active Claude Code
sessions glanceable, expressive, and pleasant without inspecting terminal text
or adding another model call.

## What the pet communicates

The pet has two independent concepts:

1. **Session status** answers whether attention is needed: running, waiting for
   input, ready, blocked, or ended.
2. **Activity pose** answers what Claude is doing: greeting, thinking, reading,
   writing, using a tool, talking, compacting, or resting.

Keeping these separate prevents ambiguous UI. A pet can be using a tool while
the session is running, or remain in a permission pose while the session needs
input.

## Product principles

- **Glanceable:** the pose and a small status cue should be understandable in
  under a second.
- **Quiet:** motion supports awareness; it does not compete with work.
- **Lightweight:** no bundled Chromium, React runtime, background cloud
  service, or extra LLM request is required.
- **Private:** the visual layer receives semantic state, never prompt text,
  generated content, tool arguments, or tool results.
- **Faithful:** a displayed state must come from a real Claude lifecycle event.
  The app must not invent activity to look alive.
- **Recoverable:** reconnecting the overlay obtains a current snapshot before
  consuming new events.
- **Understandable:** small modules, explicit contracts, and runnable tests make
  the code approachable to humans and coding agents.

## Initial experience

Version one is one transparent, always-on-top pet for one Claude session:

- start Claude and the connected pet with `claude-emote`;
- drag it anywhere on the desktop;
- see distinct poses for thinking, reading, writing, tools, speech, failures,
  and compaction;
- see a clear attention state when Claude needs input;
- retain the last position;
- reconnect automatically if the session process briefly disappears;
- close automatically when its owning session ends, unless pinned.

The existing terminal avatar remains a supported renderer.

The current repository has proven the native window and live semantic stream
separately. Automatic launcher-to-overlay orchestration is the remaining gate
before this initial experience is complete. See `docs/USER_FLOW.md`.

## Later, without redesigning the core

- One pet per session, with a short project label.
- A small nest or dock that groups several sessions.
- Replaceable character packs with a documented manifest.
- Reduced-motion and accessibility modes.
- Optional sounds that are off by default.
- A native Tauri shell if distribution, tray, or updater requirements outgrow
  Neutralino. The web UI and semantic protocol should not need to change.

## Explicit non-goals

- Reading or scraping the terminal.
- Showing hidden chain-of-thought.
- Sending session content to another service.
- Being a full Claude client or terminal emulator.
- Simulating progress when Claude is idle or disconnected.
- Shipping a pet marketplace before the single-session experience is reliable.

## Acceptance for the first desktop slice

The slice is useful when a developer can run one command, see a transparent
pet, exercise every pose, drag it, restart it without losing position, and run
the state-rendering tests without opening a native window.
