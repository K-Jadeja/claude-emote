# Sprint: Glanceable session identity

Status: complete

## Outcome

Each desktop pet identifies the Claude Code session with a short human-readable
project label instead of exposing an opaque Claude session UUID.

## Privacy decision

The default label is only the final directory name of the launcher's current
working directory. The full path never enters HTTP state, SSE, logs, URLs, or
argv. Users can override the label or hide it entirely.

## Checklist

- [x] Derive and validate a short label without retaining a full path.
- [x] Support `CLAUDE_EMOTE_SESSION_LABEL` and an explicit hide option.
- [x] Pass the label only to the native overlay child environment.
- [x] Keep the five-field semantic state contract unchanged.
- [x] Render the project label without allowing markup injection.
- [x] Use a short session fallback rather than a full opaque UUID.
- [x] Add unit, launcher, privacy, and installed-package coverage.
- [x] Verify the native live pet visually.
- [x] Update README, protocol, architecture, source map, and diagnostics.
- [x] Run full release gates and commit without pushing.

## Deferred from this sprint

- A global tray or daemon.
- Cross-process multi-pet layout coordination.
- Pinning a pet after its owning host exits.
- Focusing the correct terminal window.

Those features require an explicit ownership and discovery design; they should
not be simulated with orphan processes or unauthenticated global state.

## Verification

- Native Windows live run rendered the complete pet and the explicit
  `CLAUDE EMOTE DEV` label at 125% display scaling. The physical window was
  340 by 405 pixels for the 272 by 324 CSS design surface.
- All 605 tests in 54 files passed.
- Desktop and root TypeScript checks passed.
- The installed-tarball desktop smoke proved that the overlay receives only
  the current directory basename and the Claude child receives no label
  metadata.
- Runtime audit reported zero vulnerabilities.
- Upstream verification checked all 140 immutable or provenance-tracked files.
