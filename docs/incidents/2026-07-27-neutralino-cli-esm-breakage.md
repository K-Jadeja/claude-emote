# Neutralino CLI ESM Dependency Breakage

Date: 2026-07-27

## Impact

Installing `@neutralinojs/neu@11.7.2` made every `neu` command fail before
argument parsing:

```text
Error [ERR_REQUIRE_ESM]: require() of ES Module .../uuid/... not supported
```

This blocked runtime setup, development launch, and packaging.

## Root cause

CLI 11.7.2 declares `uuid ^14.0.0`, while its CommonJS websocket module calls
`require("uuid")`. uuid 14 is ESM-only, so Node 20 rejects that call.

## Resolution

Pin `@neutralinojs/neu` to 11.7.1. That release declares the CommonJS-compatible
uuid 8 dependency and starts correctly on the repository's Node 20 baseline.
Do not change this to a caret range until the upstream CLI loads its dependency
compatibly.

## Regression coverage

`tests/integration/neutralino-cli.test.ts` starts the installed CLI under the
current Node executable and rejects the original `ERR_REQUIRE_ESM` failure.

## Upgrade workflow

1. Install the proposed CLI version without a range.
2. Run the CLI integration test.
3. Run `npm run overlay:setup` and `npm run overlay:run`.
4. Only then update the exact version and this note.

