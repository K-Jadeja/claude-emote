# State Machine

claude-emote's avatar state is one of the ten states defined by the
upstream pi-emote engine: `hi`, `idle`, `think`, `talk`, `read`, `write`,
`tool`, `success`, `failure`, `compact`.

This document is the authoritative description of how Claude Code
lifecycle events map to those states, and the priority rules that
govern ordering when events arrive close together.

## Mapping table

| Claude event             | Avatar behaviour                                       |
| ------------------------ | ------------------------------------------------------ |
| `SessionStart`           | `hi`, followed by normal animator transition to `idle` |
| `UserPromptSubmit`       | `think`                                                |
| `PreToolUse: Read`       | `read`                                                 |
| `PreToolUse: Glob`       | `read`                                                 |
| `PreToolUse: Grep`       | `read`                                                 |
| `PreToolUse: WebFetch`   | `read`                                                 |
| `PreToolUse: WebSearch`  | `read`                                                 |
| `PreToolUse: Edit`       | `write`                                                |
| `PreToolUse: Write`      | `write`                                                |
| other `PreToolUse`       | `tool`                                                 |
| successful `PostToolUse` | transient `read`, then `think` (V1 emits `think` immediately) |
| `PostToolUseFailure`     | `failure`, then `think`                                |
| `PostToolBatch`          | `think`                                                |
| `MessageDisplay`         | `talk` (+ talk token fed to `Animator.onTalkToken`)    |
| `PermissionRequest`      | `think` for V1                                         |
| `PermissionDenied`       | `failure`, then `think`                                |
| `SubagentStart`          | `tool`                                                 |
| `SubagentStop`           | `think`                                                |
| `TaskCreated`            | `tool`                                                 |
| `TaskCompleted`          | `think`                                                |
| `PreCompact`             | `compact`                                              |
| `PostCompact`            | `idle`                                                 |
| `Stop`                   | `idle`                                                 |
| `StopFailure`            | `failure`                                              |
| `SessionEnd`             | clean shutdown for that session (no state transition)  |

The mapping is implemented in one file: `src/claude/event-mapper.ts`.
Tests in `tests/unit/event-mapper.test.ts` assert the contract for
every documented Claude event.

## Priority rules

1. **`SessionEnd` is destructive.** It triggers `shutdown: true` from
   the mapper. The server clears all timers, disposes the renderer,
   restores the cursor, and exits the process with status 0. No
   further events are processed for that session.

2. **Failure and compact temporarily outrank ordinary activity.**
   - `failure` is a `hold` state (1200 ms by default). During the hold,
     `read`/`write`/`tool` cycles do not cancel it; `think` and `talk`
     are intercepted by the Animator's `clearStateTimers()` path
     only if the *user* explicitly transitions.
   - `compact` is sticky: there is no auto-transition out of it. Only
     `PostCompact` or `Stop` moves the avatar on.
   - This matches the spec's "temporarily outrank" rule: a
     `PostToolUse` that arrives during a `failure` hold does not
     cancel the failure — the Animator's hold timer is allowed to
     finish.

3. **Later events cancel stale transient timers.** The Animator's
   `clearStateTimers()` runs at the top of every `transitionTo`. This
   means a `Stop` that arrives 50 ms after a `PreToolUse: Bash`
   correctly cancels the in-flight `tool` cycle and lands the avatar
   on `idle` instead of letting the cycle finish.

4. **`MessageDisplay.final` does NOT trigger the transition out of
   `talk`.** Only `Stop` (and the Animator's internal duration timer)
   can do that. The spec is explicit about this: "Do not treat
   `MessageDisplay.final` as the end of the complete Claude turn."

5. **`MessageDisplay` delta tokens feed the mouth, not the state.**
   The mapper forwards `delta.content` to `Animator.onTalkToken()`,
   which only adjusts the mouth-open/mouth-closed pattern. The avatar
   remains in `talk` state until the Animator's own duration timer
   decides to transition out (when no more tokens arrive for 200 ms).

6. **Empty `MessageDisplay` deltas are forwarded verbatim** so the
   Animator can decide what to do (the spec says: "Ignore empty
   `MessageDisplay.delta` for mouth-token accounting, but still
   honour `final`"). The mapper does not pre-filter; the Animator
   treats zero-word tokens as no-ops.

7. **`think` is a placeholder, not a model-driven state.** The spec
   is explicit: claude-emote does not claim to detect hidden
   reasoning tokens. `think` is inferred from lifecycle events
   only (prompt submit, tool completion, subagent stop, task
   completion, permission request).

## Timer relationships

The copied Animator owns these timers (see `src/core/animator.ts`):

- `holdTimer` — `hi` / `success` / `failure` hold duration
- `blinkTimer` — `idle` blink cadence (random 3-6s)
- `talkTimer` — `talk` mouth tick (default 120 ms)
- `cycleTimer` — `read` / `write` / `tool` frame cycling (default 500 ms)
- `thinkTimer` — `think` ↔ `think_hard` swap (random 3-6s)
- `talkGapTimer` — 200 ms gap that flips `talkMouthClosed`
- `talkDurationTimer` — drives `talk` → `idle` when tokens stop

`transitionTo(state)` calls `clearStateTimers()` at the top, so any
new state cleanly replaces the old. The exception is `blinkTimer`:
when entering `idle` and a blink is already scheduled, the existing
blink is cancelled and a new one is scheduled. This is the upstream
behaviour and we do not change it.

## What the mapper does NOT do

- The mapper does not parse the visible terminal output.
- The mapper does not make LLM calls.
- The mapper does not persist state across sessions.
- The mapper does not cache or coalesce events.

The mapper is pure: same input → same output. All ordering decisions
happen inside the Animator.
