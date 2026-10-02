# User Flow and Claude Code Integration

## Decision

The public entry point remains `claude-emote`.

It is not a separate AI client and it does not replace Claude Code. It is a
small supervisor that starts the real `claude` process together with the local
session host and the visual companion.

On Windows x64, that launcher now starts the desktop overlay automatically.
The terminal renderer remains an explicit available renderer, not a second
product.

## First-run flow

The packaged installation provides:

```powershell
claude-emote
```

and accept the same arguments the user would give Claude:

```powershell
claude-emote --resume
claude-emote --model opus
claude-emote --dangerously-skip-permissions
```

The launcher must pass those arguments through unchanged except for adding this
package's Claude Code plugin directory.

## Launch sequence

```text
User runs claude-emote
        |
        v
Resolve real Claude Code executable
        |
        v
Allocate random loopback port + session ID + capability token
        |
        v
Start per-session Node host
        |
        +---- wait for /health
        |
        v
Start desktop overlay with endpoint + capability in its child environment
        |
        +---- wait for native-window readiness
        |
        v
Start real Claude Code with bundled plugin
        |
        v
Forward terminal input/output and Claude's eventual exit code
```

The capability is required by every session route except content-free health.
Binding to loopback and restrictive CORS are useful additional boundaries, but
they do not authenticate another local process.

## During a session

Claude Code invokes the bundled command hook at supported lifecycle points. The
hook bridge reads one JSON payload from stdin and immediately posts it to the
per-session host.

```text
Claude hook payload
        |
        v
Validate event envelope
        |
        v
Map to AvatarReaction
        |
        +---- drive terminal renderer, if selected
        |
        v
Map to PetSessionState
        |
        v
Publish snapshot + SSE state event
        |
        v
Desktop pet validates sequence and changes animation
```

The bridge must remain observational:

- it exits successfully so a pet problem does not alter Claude's operation;
- it never approves, denies, or changes a tool call;
- it does not print content into Claude's context;
- it does not make a model request;
- it does not persist raw hook payloads.

## Attention flow

The status and activity are deliberately separate.

Example:

```text
PermissionRequest
    status   = needs-input
    activity = thinking
```

The strong status cue communicates that the user must act. The pose communicates
what kind of moment the session is in. The UI should not rely on animation
alone, because motion may be reduced or missed.

The desktop pet is initially informational. Clicking it must not approve a
Claude permission request. The hover-revealed "Focus terminal" action
(`POST /focus`) brings the originating Windows Terminal pane to the
foreground — best-effort, pane-precise, and a silent no-op when the host
is not running inside WT. The user still approves permissions inside Claude.

## End and cleanup flow

Normal shutdown:

1. Claude emits `SessionEnd`.
2. The host publishes `status: ended`.
3. The pet shows its ended/resting state for a short bounded period.
4. Claude exits.
5. The launcher forwards Claude's exit code.
6. The per-session host and unpinned overlay exit.

If `SessionEnd` is missing because Claude or the terminal is killed, parent-PID
watching still closes the host. The overlay shows disconnected rather than
inventing a successful end state. The focus button remains available through
`disconnected` and `ended` statuses so the user can still reach their
terminal after a transient drop.

## Failure behavior

The companion is an enhancement to Claude, not a gate in front of it.

| Failure | Required behavior |
| --- | --- |
| Claude executable missing | Fail clearly; there is no usable session |
| Session host cannot bind or become healthy | Report the cause; do not claim the pet is running |
| Overlay fails after bounded recovery | Report it and start Claude without a pet |
| Hook delivery fails | Exit the observational hook without blocking Claude; record diagnostics when configured |
| Invalid semantic state | Reject it and retain the last valid state |
| Stream disconnects | Show disconnected and reconnect to a fresh snapshot |
| Required artwork missing | Fail the build; never substitute a misleading pose |
| Claude exits unexpectedly | Preserve its exit code and clean owned child processes |

Starting Claude without the pet is a valid degraded mode because it preserves
Claude Code's identity, billing, privacy, files, and behavior. Reporting a pet
as connected when its host failed would not be valid.

## Why command hooks are the V1 integration

Claude Code command hooks provide:

- lifecycle events emitted by Claude itself;
- a stable session ID;
- plugin packaging;
- deterministic execution that is independent of model judgment;
- environment variables containing the launcher's random endpoint and
  capability;
- fail-open behavior appropriate for an observational companion.

They also let the repository keep one narrow bridge that sanitizes data before
anything reaches the browser-readable protocol.

## Alternatives considered

### Direct HTTP hooks

Direct HTTP hooks can remove the short-lived bridge process. They are attractive
for a later stable local daemon, but the current per-session design allocates a
random endpoint at launch. The bridge resolves that endpoint from the session
environment and keeps the plugin portable.

Revisit direct HTTP hooks only if the multi-session daemon contract makes them
materially simpler. Do not introduce a fixed unauthenticated port merely to
remove the bridge.

### Terminal scraping

Rejected. Terminal text is presentation, not a lifecycle API. Scraping is
brittle across themes and Claude releases and would expose prompts, outputs,
commands, and paths to the visual layer.

### Transcript-file watching

Rejected for live state. It consumes more private data than the pet needs,
introduces file-format coupling, and still requires inference about activity.

### MCP tool

Rejected for automatic lifecycle state. An MCP tool is called by the model when
the model chooses to call it. The pet needs deterministic updates even when the
model never mentions the companion.

### Claude Agent SDK wrapper

Rejected for this product. It would make `claude-emote` responsible for a new
chat client and permission UI instead of augmenting the real Claude Code
experience.

### Always-running global daemon first

Deferred. A daemon is useful for tray controls and many simultaneous sessions,
but it adds discovery, authentication, upgrades, stale-state repair, and
cross-user process ownership. A per-session supervisor is easier to make
correct first.

## Relationship to Codex pets

The product experience is intentionally similar:

- a small companion lives outside the main text flow;
- animation reflects real agent state;
- waiting and completion are visible at a glance;
- custom artwork can eventually be installed as a validated pack.

The integration is necessarily different. A Codex application can receive its
own internal session state and render a pet as part of its native product.
`claude-emote` is an external Claude Code plugin and launcher, so it uses
Claude's public lifecycle-hook boundary.

This repository should use Codex pets as UX and asset-contract inspiration, not
depend on private app internals or copied proprietary code. The current
animation engine and artwork derive from the explicitly attributed MIT-licensed
pi-emote project.

## Multi-session evolution

The single-session protocol already includes `sessionId`, so it can evolve
without changing the desktop state shape:

1. one launcher, one host, one pet;
2. multiple launchers, one pet window per session;
3. optional tray process discovers authenticated session hosts;
4. a "nest" groups pets and focuses the selected terminal;
5. durable preferences choose one-pet-per-session or grouped mode.

The tray must not become the source of truth. Each owning session host remains
authoritative for its own current state.

## Automatic desktop launch acceptance

- `claude-emote` starts the desktop pet and real Claude with one command.
- Every user-supplied Claude argument arrives unchanged.
- A random loopback endpoint and capability token are used per session.
- The launcher waits for both host and overlay readiness with bounded timeouts.
- A failed overlay never reports success and never prevents Claude from
  starting.
- Permission-required, ready, failed, disconnected, and ended states are
  visually distinct.
- Claude's exit code is preserved.
- Normal, signal, and crash cleanup paths have process-level regression tests.
- No raw prompt, output, tool argument, tool result, or project path appears in
  the overlay protocol.
- The complete packaged flow is visually tested at 100% and high-DPI scaling.
