# Security Notes

## Desktop privacy boundary

The desktop wire contract is intentionally limited to five semantic fields.
See `docs/DESKTOP_SESSION_PROTOCOL.md`. Unknown fields are rejected on the
client so prompts, generated text, tool data, paths, and credentials cannot be
added accidentally without changing tests and the protocol.

Browser reads are accepted only from loopback HTTP origins. The host itself
binds only to `127.0.0.1`.

## Dependency audit status

Verified on 2026-10-02:

```powershell
npm audit --omit=dev
```

reported zero production vulnerabilities.

The full development audit reports two moderate findings: `uuid` and its
parent `@neutralinojs/neu@11.7.1` packaging CLI. There are no high or critical
findings. Runtime `adm-zip` is updated to 0.6.1; Vitest is pinned to 4.1.11,
and compatible nanoid and brace-expansion security patches are locked.

Neutralino CLI 11.7.2 previously failed under Node 20: its CommonJS websocket
module required ESM-only uuid 14 and crashed before parsing commands. The CLI
remains pinned pending revalidation across the supported Node versions.
`tests/integration/neutralino-cli.test.ts` checks this failure boundary;
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

The local event/state/stream endpoints now require a per-session capability
token. Signing and installer distribution remain outstanding. See
`GITHUB_PUBLICATION.md` for the current beta's validation boundaries.

