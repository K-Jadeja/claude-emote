# Hook Protocol

This document is the wire-level contract between Claude Code and the
claude-emote avatar process. It covers the bridge, the HTTP endpoint,
and the event payload.

## Lifecycle

```
Claude Code ── invokes ──> dist/claude/hook-bridge.js
                              │
                              │  reads stdin (hook JSON)
                              │  reads CLAUDE_EMOTE_ENDPOINT
                              ▼
                       POST /event
                              │
                              ▼
            127.0.0.1:<port> avatar server
                              │
                              │  applies event-mapper
                              ▼
                       src/core/Animator
                              │
                              ▼
                       renderer → terminal pane
```

## Hook registration

`hooks/hooks.json` registers the same `node ${CLAUDE_PLUGIN_ROOT}/dist/claude/hook-bridge.js`
command for every supported Claude Code hook event. The bridge reads
`hook_event_name` from stdin and forwards the unmodified payload to the
avatar server — it does not need to be reconfigured per event.

`MessageDisplay` is intentionally registered without a matcher so every
message update (delta and final) is delivered.

## Bridge contract

| Field                | Source                | Notes |
| -------------------- | --------------------- | ----- |
| stdin                | Claude Code           | The unmodified hook JSON. |
| `CLAUDE_EMOTE_ENDPOINT` | env (set by launcher) | Full URL, e.g. `http://127.0.0.1:51234/event`. |
| `CLAUDE_EMOTE_DEBUG` | env                   | If `"1"`, debug logs go to stderr. |
| `CLAUDE_EMOTE_BRIDGE_TIMING_FILE` | env (benchmark only) | Internal: write a JSON line for each run. |
| stdout               | (never written)       | Bridge is silent on stdout. |
| stderr               | debug logs only       | Only populated when `CLAUDE_EMOTE_DEBUG=1`. |
| exit code            | always 0              | Failure to reach the avatar server does NOT fail Claude Code. |

## HTTP endpoint

| Path    | Method | Body                                    | Response |
| ------- | ------ | --------------------------------------- | -------- |
| `/event` | POST   | The unmodified hook JSON as the body, `content-type: application/json`. | 200, ignored. |
| `/health` | GET | (none)                                  | 200 with `{ "ok": true, "instanceId": "..." }` |

The avatar server is bound only to `127.0.0.1`. It rejects request bodies
larger than 256 KiB. It does not authenticate — only processes on the same
host can reach it.

## Event payload shape

The avatar server receives the exact JSON Claude Code sent. It only reads
the fields the event mapper needs:

```ts
interface HookEvent {
  hook_event_name:
    | "SessionStart" | "UserPromptSubmit" | "MessageDisplay"
    | "PreToolUse"   | "PostToolUse"      | "PostToolUseFailure"
    | "PostToolBatch"| "PermissionRequest" | "PermissionDenied"
    | "SubagentStart"| "SubagentStop"     | "TaskCreated"
    | "TaskCompleted"| "Stop"             | "StopFailure"
    | "PreCompact"   | "PostCompact"      | "SessionEnd";
  session_id: string;
  // Per-event fields (see src/claude/hook-event.ts)
}
```

The mapper never throws on unknown / malformed input. The bridge never
parses the payload, only forwards it.

## MessageDisplay handling

Claude Code sends one `MessageDisplay` event per streaming update, plus
a final event when the turn is complete. The bridge forwards all of them
unchanged. The avatar server:

- emits `talk` state on every MessageDisplay
- forwards `delta.content` to `Animator.onTalkToken()`
- never reads `delta.content` to rewrite it
- never returns a `displayContent` field

The `Stop` event is the only one that transitions the avatar back to
`idle`; `MessageDisplay.final` does NOT.

## Failure modes

| Condition | Bridge behaviour | Claude Code impact |
| --------- | ---------------- | ------------------ |
| `CLAUDE_EMOTE_ENDPOINT` unset | exits 0, no POST | None |
| Endpoint refuses connection (no avatar server) | exits 0, logs if debug | None |
| Endpoint accepts but is slow | 1500 ms request timeout, then exit 0 | None |
| stdin empty | exits 0, no POST | None |
| stdin is malformed JSON | forwards raw to server, server's mapper ignores | None |
| Bridge itself crashes | caught, logs if debug, exits 0 | None |

In every case, Claude Code continues normally. Hooks never block, deny,
approve, or change Claude behaviour.

## Performance

Numerical performance numbers live in
[`docs/BENCHMARK_RESULTS.md`](BENCHMARK_RESULTS.md) and are produced
by `npm run benchmark:latency`. The doc records four distinct
metrics — hook-bridge delivery, direct avatar event-to-frame, full
hook-to-frame, and bridge fail-open — measured on a real
machine-on-date; they are not universal results.
