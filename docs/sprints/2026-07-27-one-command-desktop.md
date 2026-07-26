# Sprint: One-command desktop pet

Status: complete

## Outcome

Running:

```powershell
claude-emote [normal Claude arguments]
```

starts the real Claude Code session and a connected native desktop pet without
manual plugin installation, endpoint configuration, or extra terminals.

## Checklist

- [x] Require a per-session capability token for hook events and desktop state.
- [x] Keep the capability out of URLs, logs, state payloads, and diagnostics.
- [x] Add a renderer-free semantic session host for desktop mode.
- [x] Make desktop mode the supported Windows default.
- [x] Preserve terminal mode and an explicit no-pet mode.
- [x] Strip only Claude Emote's namespaced options; forward all Claude options.
- [x] Start the native overlay and prove its authenticated stream is ready.
- [x] Start Claude even when the companion cannot start, with a clear warning.
- [x] Preserve Claude's exit code.
- [x] Show the ended pose for a bounded grace period.
- [x] Clean the host and overlay on normal exit, signal, failure, and crash.
- [x] Include the native overlay and resources in the installable package.
- [x] Add an installed-package one-command smoke test.
- [x] Add a secret-safe `claude-emote --emote-doctor` diagnostic.
- [x] Verify native visuals and the device-pixel-ratio sizing contract.
- [x] Run typechecks, all tests, runtime audit, package validation, and diff checks.
- [x] Update README, architecture, protocol, source map, and incident/workflow docs.
- [x] Commit the completed sprint without pushing or deploying.

## Fixed decisions

- The user-facing entry point remains `claude-emote`.
- The bundled Claude plugin is internal implementation; users do not install it.
- MCP is not part of lifecycle-state delivery.
- Desktop mode uses a headless semantic host, not a hidden terminal renderer.
- Authentication uses an HTTP authorization header. The token is inherited
  through the launcher-owned child environments and never placed in a URL.
- A companion failure does not block Claude Code.
- The launcher never silently substitutes terminal mode for failed desktop mode.

## Acceptance

The sprint is complete only after an installed or install-shaped command can:

1. launch a real authenticated session host;
2. launch the native overlay;
3. observe overlay stream readiness;
4. launch a fake or real Claude process with its arguments unchanged;
5. deliver production-shaped hooks;
6. display attention and ended states;
7. exit with Claude's exit code and leave no owned processes.

## Verification

- Native Windows package launched through the real launcher and acknowledged
  readiness only after an authoritative frame decoded.
- Production-shaped events exercised start, thinking, permission attention,
  stop, and session end.
- `npm test`: 51 files and 588 tests passed.
- Node and desktop typechecks passed.
- Runtime audit reported zero vulnerabilities.
- Immutable upstream verification covered 140 files.
- Package validation installed the tarball outside the repository and passed
  the one-command desktop, plugin, terminal, and exclusion smoke tests.
