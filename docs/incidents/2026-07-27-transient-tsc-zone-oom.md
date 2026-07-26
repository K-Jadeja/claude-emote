# Transient TypeScript V8 Zone OOM

Date: 2026-07-27

## Symptom

The first complete verification command ran two successful typechecks and then
the `npm test` pretest build crashed before Vitest started:

```text
Fatal process out of memory: Zone
```

## Investigation

- `NODE_OPTIONS` was empty.
- Node reported a normal 4144 MiB heap limit.
- The host had 42 Node processes from several concurrent Codex/MCP sessions,
  with about 2.9 GiB combined private memory.
- About 4.1 GiB of physical memory remained available.
- A direct `npm run build` immediately succeeded.
- A subsequent unmodified `npm test` completed all 560 tests.

## Conclusion

No repository-level deterministic leak was found. The failure was transient
host/process pressure during three back-to-back TypeScript processes. Adding a
larger heap flag would hide the environmental condition and was not justified.

## Repeat workflow

1. Check `NODE_OPTIONS` and Node's reported heap limit.
2. Record Node process count and available physical memory.
3. Run `npm run build` once.
4. Re-run the unchanged complete command.
5. If the same failure repeats, capture a heap profile before changing memory
   limits or test concurrency.

## Verification

The unchanged full suite subsequently passed:

```text
Test Files  42 passed (42)
Tests       560 passed (560)
Duration    81.69s
```

