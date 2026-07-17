# Benchmark Results (Phase 9B)

This document records the four Phase 9B latency measurements on a single machine on a single date. These numbers are not universal results; do not extrapolate them to other hardware, OS releases, or Node versions.

The numbers are produced by `npm run benchmark:latency -- --runs=3 --samples=50 --warmup=10 --fail-open-samples=30 --output-dir=docs/benchmarks` and are derived from the validated raw record `docs/benchmarks/phase9b-raw.json`.

The raw record preserves every measured duration and frame match. Bridge exit
code and signal are enforced during every sample by the benchmark process but
are not duplicated as per-sample fields in schema version 1; any nonzero or
signalled bridge would make the benchmark exit nonzero and prevent result
generation.

## Recorded run

| | |
| --- | --- |
| Date (UTC) | 2026-07-18T06:20:16.197Z |
| Machine | 13th Gen Intel(R) Core(TM) i5-13420H, 12 logical CPUs, 15.65 GiB RAM, Windows_NT 10.0.26200 x64 |
| Git commit | `7c2cc94dc03eda55d4f23b6a2911743100f063b5` (clean) |
| Branch | `fix/wt-pane-avatar-readiness` |
| Working tree | clean |
| Node | v20.15.0 |
| npm | 10.8.2 |
| package.json version | 0.1.0 |
| Claude Code | 2.1.193 (Claude Code) |
| Hook timeout | 2 s (every hook entry in hooks/hooks.json) |
| Configuration | runs=3, samples=50, warmup=10, failOpenSamples=30 |

### Aggregate (over three runs, n = 150 each except fail-open = 90)

| Metric | min | p50 | p95 | p99 | max | mean | sd |
| ------ | --- | --- | --- | --- | --- | ---- | -- |
| `bridgeSpawnToServerReceiveMs` | 42.76 | 48.71 | 60.86 | 80.04 | 88.40 | 50.28 | 6.24 |
| `bridgeSpawnToExitMs` | 48.84 | 55.07 | 69.30 | 86.17 | 96.16 | 56.97 | 6.64 |
| `directPostToResponseMs` | 0.81 | 1.85 | 2.61 | 2.79 | 2.91 | 1.92 | 0.43 |
| `directPostToFrameMs` | 14.92 | 15.59 | 16.29 | 18.44 | 20.07 | 15.70 | 0.56 |
| `fullHookToBridgeExitMs` | 58.35 | 70.59 | 88.05 | 99.97 | 122.32 | 71.88 | 8.77 |
| `fullHookToFrameMs` | 61.74 | 77.88 | 93.53 | 109.62 | 123.76 | 80.69 | 8.20 |
| `failOpenBridgeExitMs` | 48.02 | 52.68 | 70.79 | 80.66 | 80.66 | 54.94 | 6.66 |

All displayed values are milliseconds.

### Per-run summary

| Metric | Run 1 p50 / p95 / max | Run 2 p50 / p95 / max | Run 3 p50 / p95 / max |
| ------ | --------------------- | --------------------- | --------------------- |
| `bridgeSpawnToServerReceiveMs` | 48.80 / 61.84 / 80.04 | 49.65 / 62.05 / 88.40 | 47.38 / 54.57 / 55.24 |
| `bridgeSpawnToExitMs` | 56.08 / 68.52 / 86.17 | 56.31 / 70.41 / 96.16 | 53.61 / 61.53 / 71.47 |
| `directPostToResponseMs` | 1.83 / 2.61 / 2.91 | 1.77 / 2.67 / 2.79 | 1.90 / 2.54 / 2.62 |
| `directPostToFrameMs` | 15.51 / 16.36 / 20.07 | 15.63 / 16.18 / 18.44 | 15.63 / 16.29 / 16.36 |
| `fullHookToBridgeExitMs` | 70.81 / 85.89 / 98.43 | 70.05 / 97.93 / 122.32 | 69.64 / 81.22 / 90.84 |
| `fullHookToFrameMs` | 77.91 / 93.45 / 108.68 | 77.63 / 108.23 / 123.76 | 77.92 / 93.53 / 94.43 |
| `failOpenBridgeExitMs` | 53.41 / 72.05 / 79.20 | 51.93 / 65.27 / 80.66 | 53.02 / 70.79 / 73.18 |

Raw per-sample arrays are in [`phase9b-raw.json`](benchmarks/phase9b-raw.json).

### Threshold results

| Gate | Threshold | Observed (aggregate) | Result |
| ---- | --------- | -------------------- | ------ |
| bridge spawn → exit max < hook timeout | < 2000 ms | max = 96.16 ms | PASS |
| fail-open bridge exit max < hook timeout | < 2000 ms | max = 80.66 ms | PASS |
| full hook → frame p95 < 5000 ms | < 5000 ms | p95 = 93.53 ms | PASS |
| full hook → frame max < 6000 ms | < 6000 ms | max = 123.76 ms | PASS |
| direct → frame p95 ≤ 300 ms (info) | ≤ 300 ms | p95 = 16.29 ms | MEETS |
| full hook → frame p95 ≤ 750 ms (info) | ≤ 750 ms | p95 = 93.53 ms | MEETS |

### State sweep (informational, post-to-frame ms)

| Event/state | n | min | p50 | p95 | max | mean |
| ----------- | - | --- | --- | --- | --- | ---- |
| MessageDisplay → talk | 30 | 12.65 | 14.15 | 15.91 | 28.03 | 14.64 |
| PreToolUse Read → read | 30 | 13.03 | 14.20 | 16.63 | 22.37 | 14.62 |
| PreToolUse Write → write | 30 | 12.60 | 13.88 | 15.59 | 29.06 | 14.41 |
| PostToolUseFailure → failure | 30 | 12.10 | 14.01 | 15.55 | 28.78 | 14.39 |
| PreCompact → compact | 30 | 11.21 | 14.26 | 18.38 | 22.24 | 14.36 |
| Stop → idle | 30 | 10.51 | 12.16 | 19.00 | 24.61 | 12.63 |

Each state-sweep sample sends the fixture and observes a frame strictly after the baseline timestamp. Stop → idle forces a think-then-stop cycle so the post-baseline idle frame is a genuine transition, not a no-op redraw.

### Avatar startup

- Run 1: avatar requested port 0, OS-selected actual port 56892
- Run 2: avatar requested port 0, OS-selected actual port 57108
- Run 3: avatar requested port 0, OS-selected actual port 57326

## Limitations

1. **One machine, one date.** The numbers above do not generalize.
2. **No real Claude Code session.** The benchmark stops at the bridge input boundary. It cannot measure the time Claude itself takes before firing a hook.
3. **No real Windows Terminal drawing.** The benchmark observes the frame at the moment the avatar writes it to stdout. Real WT redraw scheduling and human visual perception are outside scope.
4. **ASCII renderer only on Windows.** Bundled PNG / Sixel rendering requires Chafa and is not exercised here.
5. **The benchmark cannot reproduce Claude's hook emission jitter.** In production, Claude Code's hook firing time is itself variable (queue depth, model output rate, etc.) and is outside the local path the benchmark measures.
