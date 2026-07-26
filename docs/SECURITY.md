# Security Notes

## Desktop privacy boundary

The desktop wire contract is intentionally limited to five semantic fields.
See `docs/DESKTOP_SESSION_PROTOCOL.md`. Unknown fields are rejected on the
client so prompts, generated text, tool data, paths, and credentials cannot be
added accidentally without changing tests and the protocol.

Browser reads are accepted only from loopback HTTP origins. The host itself
binds only to `127.0.0.1`.

## Dependency audit status

Verified on 2026-07-27:

```powershell
npm audit --omit=dev
```

reported zero production vulnerabilities.

The full development audit reports seven findings, all below the pinned
`@neutralinojs/neu@11.7.1` packaging CLI:

- `@electron/asar`
- `brace-expansion`
- `glob`
- `minimatch`
- `recursive-readdir`
- `uuid`
- the CLI package itself

There are no remaining critical findings. Vitest was upgraded to 4.1.10 to
remove the prior critical test-server advisory and its old Vite chain.

Neutralino CLI 11.7.2 is not currently a safe upgrade: its CommonJS websocket
module requires ESM-only uuid 14 and crashes before parsing commands on Node
20. `tests/integration/neutralino-cli.test.ts` locks this exact failure branch;
see `docs/incidents/2026-07-27-neutralino-cli-esm-breakage.md`.

The affected CLI is a local development/packaging tool. It is not bundled in
the desktop resources or installed as a production dependency. Until upstream
ships a working release:

1. run it only against this trusted repository;
2. do not feed untrusted archive or glob input to packaging;
3. keep 11.7.1 pinned exactly;
4. re-run the CLI smoke test, package smoke test, and both audits before
   upgrading.

## Release checks

```powershell
npm audit --omit=dev
npm run typecheck
npm run overlay:typecheck
npm test
npm run overlay:package
```

Before public distribution, add a per-session capability token to the local
state stream and complete signing/notarization for each platform.

