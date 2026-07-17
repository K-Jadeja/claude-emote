# Test Plan

This document describes the automated test suite for claude-emote.
The M5 manual test plan is in `docs/INTEGRATION_RESULTS.md`.

## Test runner

`vitest`. The `npm test` script runs the full suite. `npm run test:unit`
runs unit tests only; `npm run test:integration` runs integration
tests only.

## Unit tests

| File | Subject | Coverage |
| ---- | ------- | -------- |
| `tests/unit/animator.test.ts` | The copied Animator (state machine, timers) | hi→idle · blink · think swap · talk mouth · onTalkToken · read/write/tool cycles · failure hold · compact stays · transition cancels stale timers · clearAllTimers |
| `tests/unit/standalone-render-host.test.ts` | The StandaloneRenderHost | requestRender contract · debouncing · silent mode · non-silent terminal writes · ghost-line erasure · image sequences |
| `tests/unit/renderer-factory.test.ts` | Renderer selection | ASCII construction · Sixel construction · setTuiHost wiring |
| `tests/unit/event-mapper.test.ts` | The event mapper | one assertion per documented fixture · empty MessageDisplay delta · final MessageDisplay · malformed input tolerance · SessionEnd shutdown flag |

## Integration tests

| File | Subject | Coverage |
| ---- | ------- | -------- |
| `tests/integration/hook-bridge.test.ts` | The compiled bridge (`dist/claude/hook-bridge.js`) | forwards unmodified payload · exits 0 with missing endpoint · exits 0 with unreachable endpoint · exits 0 with empty stdin · exits 0 with malformed JSON · silent on stderr unless debug · writes stderr with debug |
| `tests/integration/avatar-server.test.ts` | The compiled avatar process (`dist/host/avatar-process.js`) | /health returns correct instanceId · 404 for unknown paths · SessionStart → hi · PreToolUse:Read → read · Stop → idle · SessionEnd → shutdown · oversized body rejected · malformed JSON rejected · MessageDisplay delta forwarded |

## Latency benchmark (Phase 9B)

`scripts/benchmark-latency.mjs` (registered as `npm run benchmark:latency`)
drives four distinct metrics against the compiled production artifacts:

A. Hook-bridge delivery (against a small benchmark HTTP server)
B. Direct avatar event-to-frame (real avatar, observed frame on stdout)
C. Full hook-to-frame (real bridge → real avatar → stdout frame)
D. Hook-bridge fail-open against an unavailable endpoint

Full methodology, acceptance thresholds, and recorded numbers live in
[`docs/BENCHMARK_RESULTS.md`](BENCHMARK_RESULTS.md). Raw samples are
written to [`docs/benchmarks/phase9b-raw.json`](benchmarks/phase9b-raw.json).
The older `scripts/benchmark-bridge.mjs` and `scripts/measure-latency.mjs`
have been removed; their percentile and reporting methodology did not
match the authoritative Phase 9B contract.

## Vendor verification

`scripts/verify-upstream.mjs` (registered as `npm run verify:upstream`)
checks that every file under `vendor/pi-emote-original/` still matches
the recorded SHA-256 hash list (`vendor/pi-emote-original.sha256`).
Use `--record` after pulling a new upstream commit.

## CI recommendations

| Stage | Command |
| ----- | ------- |
| Lint / typecheck | `npm run typecheck` |
| Unit | `npm run test:unit` |
| Integration | `npm run test:integration` |
| Vendor | `npm run verify:upstream` |
| Benchmark (informational) | `npm run benchmark:bridge` |
| Latency sweep | `node scripts/measure-latency.mjs` |

The benchmark and latency sweep are informational in CI; they are
environment-sensitive and may produce WARN-level output on Windows
due to `node` spawn overhead.
