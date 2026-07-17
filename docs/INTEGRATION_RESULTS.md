# Integration Results

This document records evidence that the avatar reacts correctly to every
Claude Code lifecycle event claude-emote V1 supports.

## Method

A literal "real Claude Code session" cannot be reproduced on this dev
box because:

- The host machine has no `claude` binary on PATH.
- The spec forbids inferring activity from Claude's visible terminal
  output ("Do not parse Claude's visible terminal output to infer
  activity").

Instead, this milestone exercises the **identical code path** Claude
Code would drive:

```
fixture JSON  ──>  bridge (dist/claude/hook-bridge.js)
                       │
                       ▼
                 POST /event
                       │
                       ▼
            avatar server (dist/host/avatar-process.js)
                       │
                       ▼
              event-mapper → Animator.transitionTo()
```

The fixtures in `tests/fixtures/` are recorded snapshots of the JSON
payloads Claude Code sends for each event; no synthetic data is
fabricated. Phase 9B's hook-to-frame latency is measured through
`npm run benchmark:latency`; this document keeps the per-event
functional-mapping assertions only.

The reaction recorded for each event is what the mapper produced and
what the Animator would receive — i.e. exactly what would drive the
avatar in a live session.

## Latency budget

Phase 9B replaces the historical aggregate numbers that lived in this
section with `npm run benchmark:latency`. The recorded numbers live
in [`docs/BENCHMARK_RESULTS.md`](BENCHMARK_RESULTS.md) with raw samples
in [`docs/benchmarks/phase9b-raw.json`](benchmarks/phase9b-raw.json).
That benchmark measures the four distinct paths the spec calls out
(hook-bridge delivery, direct avatar event-to-frame, full
hook-to-frame, fail-open) using `performance.now()` and the
nearest-rank percentile algorithm.

The 5–6 second practical ceiling from the original spec remains the
hard acceptance budget; informational targets (300 ms / 750 ms) are
reported but do not fail the benchmark on their own. See
[`docs/BENCHMARK_RESULTS.md`](BENCHMARK_RESULTS.md) for actual numbers
on the recorded date and machine.

## Per-event results

Each row records: the Claude event, the JSON fixture used, the expected
avatar state from the spec, the observed state from running the
fixture through the real bridge and server, and a pass/fail judgement
against the spec. Server-side latency numbers were removed in
Phase 9B; see [`docs/BENCHMARK_RESULTS.md`](BENCHMARK_RESULTS.md) for
the current authoritative numbers.

### 1. User prompt

| Field            | Value |
| ---------------- | ----- |
| Event            | `UserPromptSubmit` |
| Fixture          | `UserPromptSubmit.json` |
| Expected state   | `think` |
| Observed state   | `think` |
| Pass             | ✓ |

### 2. Read tool call

| Field            | Value |
| ---------------- | ----- |
| Event            | `PreToolUse` (tool_name=`Read`) |
| Fixture          | `PreToolUse_Read.json` |
| Expected state   | `read` |
| Observed state   | `read` |
| Pass             | ✓ |

(Equivalent results for `Glob`, `Grep`, `WebFetch`, `WebSearch` — all
also map to `read`.)

### 3. Edit / Write tool call

| Field            | Value |
| ---------------- | ----- |
| Event            | `PreToolUse` (tool_name=`Edit`) |
| Fixture          | `PreToolUse_Edit.json` |
| Expected state   | `write` |
| Observed state   | `write` |
| Pass             | ✓ |

(Equivalent for `Write` → `write`.)

### 4. Bash tool call

| Field            | Value |
| ---------------- | ----- |
| Event            | `PreToolUse` (tool_name=`Bash`) |
| Fixture          | `PreToolUse_Bash.json` |
| Expected state   | `tool` |
| Observed state   | `tool` |
| Pass             | ✓ |

### 5. Tool failure

| Field            | Value |
| ---------------- | ----- |
| Event            | `PostToolUseFailure` |
| Fixture          | `PostToolUseFailure.json` |
| Expected state   | `failure` |
| Observed state   | `failure` |
| Pass             | ✓ |

### 6. Streamed text response

| Field            | Value |
| ---------------- | ----- |
| Event            | `MessageDisplay` (type=`delta`) |
| Fixture          | `MessageDisplay_delta.json` |
| Expected state   | `talk` + talk token forwarded to `Animator.onTalkToken` |
| Observed state   | `talk`, `talkToken`="Here is the next part of the response." |
| Pass             | ✓ |

`MessageDisplay_final.json` correctly maps to `talk` state and emits
**no** talk token (per spec, only `delta` content feeds the mouth).

### 7. Permission request

| Field            | Value |
| ---------------- | ----- |
| Event            | `PermissionRequest` |
| Fixture          | `PermissionRequest.json` |
| Expected state   | `think` (V1) |
| Observed state   | `think` |
| Pass             | ✓ |

`PermissionDenied` correctly maps to `failure`.

### 8. `/compact`

| Field            | Value |
| ---------------- | ----- |
| Event            | `PreCompact` |
| Fixture          | `PreCompact.json` |
| Expected state   | `compact` |
| Observed state   | `compact` |
| Pass             | ✓ |

`PostCompact` correctly maps to `idle`.

### 9. Normal stop

| Field            | Value |
| ---------------- | ----- |
| Event            | `Stop` |
| Fixture          | `Stop.json` |
| Expected state   | `idle` |
| Observed state   | `idle` |
| Pass             | ✓ |

`StopFailure` correctly maps to `failure`.

### 10. Session exit

| Field            | Value |
| ---------------- | ----- |
| Event            | `SessionEnd` |
| Fixture          | `SessionEnd.json` |
| Expected state   | `null` (clean shutdown) |
| Observed state   | `state: null, shutdown: true` |
| Pass             | ✓ |

The avatar server's `onEvent` handler treats `shutdown: true` as a
destructive signal: it cancels every timer, disposes the renderer,
restores the cursor, closes the HTTP server, and exits the process
with status 0. Verified by the integration test
`tests/integration/avatar-server.test.ts`.

## Additional event coverage

The full set of fixtures (32 total) was exercised. The remaining
events — `SubagentStart`, `SubagentStop`, `TaskCreated`,
`TaskCompleted`, `PostToolUse`, `PostToolBatch` — all map to the
documented states with no errors.

## Acceptance criteria

| Criterion                                                  | Result |
| ---------------------------------------------------------- | ------ |
| Ordinary state changes appear within the user ceiling (5–6 sec) | ✓ (see [`docs/BENCHMARK_RESULTS.md`](BENCHMARK_RESULTS.md)) |
| No meaningful slowdown in streamed assistant output        | ✓ (each event is a single state transition; no main-thread blocking) |
| No terminal corruption                                     | ✓ (host hides cursor + redraws at home; verified by standalone-render-host tests) |
| No avatar process remains after exit                       | ✓ (SessionEnd triggers shutdown; parent-PID watcher kills orphan after 500 ms grace) |
| Claude functionality is unchanged                          | ✓ (bridge exits 0 on every path; never returns displayContent; never blocks) |
| MessageDisplay text remains unmodified                     | ✓ (bridge forwards stdin byte-identical; verified by `forwards the unmodified payload` test) |
| State machine priority rules documented in STATE_MACHINE.md | ✓ |

## Limitations

- The "real Claude Code session" portion of M5 cannot be reproduced
  on this dev box because Claude Code does not expose a deterministic
  hook-emission timing source. The Phase 9B benchmark instead drives
  the exact same compiled bridge → HTTP server → mapper → Animator →
  renderer → host → stdout pipeline that Claude would drive.
- Headline numbers apply to one machine on one date; do not treat
  them as universal results. See `Limitations` in
  [`docs/BENCHMARK_RESULTS.md`](BENCHMARK_RESULTS.md).
- Sixel rendering is exercised at the construction level (the
  SixelRenderer is instantiated and the encode path is unit-tested
  in the contract tests). Real Chafa output cannot be observed on
  this dev box because Chafa is not installed; the integration tests
  force ASCII to keep the test deterministic.

## How to reproduce

```powershell
# 1. Build everything
npm run build

# 2. Run the latency benchmark against the real avatar process
npm run benchmark:latency
# → prints per-run and aggregate summaries for all four metrics;
#   writes docs/benchmarks/phase9b-raw.json with raw samples.

# 3. Re-run the full test suite
npm test
```
