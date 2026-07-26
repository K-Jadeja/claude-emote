# Demo Frame Source Recursion

Date: 2026-07-27

## Impact

`npm run demo` crashed immediately with:

```text
RangeError: Maximum call stack size exceeded
```

The demo therefore could not serve as the documented visual acceptance test.
The production avatar process did not contain this wiring error.

## Root cause

The demo replaced `renderer.getRenderedFrame()` with a function that returned
`host.peekFrame()`. It then configured the host's frame source to call
`renderer.getRenderedFrame()`. `peekFrame()` consulted the attached frame
source, producing a recursive cycle:

```text
renderer.getRenderedFrame -> host.peekFrame -> frame source
                           -> renderer.getRenderedFrame -> ...
```

The replacement was duplicated in the script, which obscured the intended
ownership. The renderer is already the authoritative owner of the latest
rendered frame and did not need an adapter override.

## Fix

Keep the renderer method intact and attach it directly:

```js
host.attachFrameSource(() => renderer.getRenderedFrame());
```

A test-only duration scale lets the integration test complete the full demo
sequence quickly without changing production timings.

## Regression coverage

`tests/integration/demo-states.test.ts` launches the actual script, exercises
all ten states, requires a zero exit code, and rejects stack-overflow output.

## Prevention

- Do not monkey-patch renderer methods in demos or tests.
- Treat the renderer as the frame owner and the host as an output adapter.
- Run the executable demo in CI, not only its component tests.

