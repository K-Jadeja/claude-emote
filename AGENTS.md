# Contributor Guide for Coding Agents

Read this file before changing the repository. The application is intended to
be a real, lightweight desktop companion for Claude Code, not a throwaway demo.

## Product goal

`claude-emote` turns Claude Code lifecycle events into an animated pet. The
current terminal renderer remains supported. The next product surface is a
small transparent desktop overlay that can embody one or more Claude sessions
without reading terminal output or making another LLM call.

Start with:

- `README.md` for install and user commands.
- `docs/PRODUCT_VISION.md` for the product contract.
- `docs/USER_FLOW.md` for the launch, session, and shutdown experience.
- `docs/COMPATIBILITY.md` for Claude Code and Claude Emote update boundaries.
- `docs/DESKTOP_OVERLAY_ARCHITECTURE.md` for the desktop design.
- `docs/DESKTOP_SESSION_PROTOCOL.md` for the privacy and streaming contract.
- `docs/DEVELOPMENT.md` for the local workflow.
- `docs/SECURITY.md` for the protocol and dependency-audit boundary.
- `docs/STATE_MACHINE.md` for hook-to-animation rules.
- `docs/SOURCE_MAP.md` for source ownership.

## Repository map

| Path | Responsibility |
| --- | --- |
| `src/claude/` | Claude hook input, validation, and event mapping |
| `src/core/` | Animation engine ported from pi-emote |
| `src/host/` | Per-session HTTP server and state coordination |
| `src/adapters/` | Terminal renderer and output adapters |
| `src/launcher/` | `claude-emote` command and process lifecycle |
| `desktop/` | Lightweight desktop overlay source |
| `emotes/default/` | Default MIT-licensed pixel-art frames |
| `tests/unit/` | Pure and small-scope behavior tests |
| `tests/integration/` | Process, HTTP, terminal, and overlay boundaries |
| `docs/incidents/` | Root causes, fixes, and prevention notes |
| `vendor/pi-emote-original/` | Immutable upstream snapshot; do not edit |

Generated directories such as `dist/`, `desktop/resources/`, and
`desktop/dist/` are not source.

## Commands

```powershell
npm install
npm run typecheck
npm run test:unit
npm test
npm run demo
npm run overlay:run
```

Use focused tests while iterating, then run the complete test suite before
handoff. See `docs/DEVELOPMENT.md` for prerequisites and troubleshooting.

## Change rules

1. Keep event mapping pure. Do not parse Claude's terminal output.
2. Do not add a second AI call just to decide which animation to show.
3. Keep raw prompts, model output, tool arguments, and tool results out of the
   overlay protocol. Send semantic state only.
4. Put native desktop behavior behind the shell adapter. UI state and rendering
   must remain testable without a native window.
5. Prefer browser APIs and small TypeScript modules over frameworks and runtime
   dependencies.
6. Never edit `vendor/pi-emote-original/`.
7. Document incidents, fixes, and repeatable workflows.
8. Every bug fix needs a regression test for the exact failing branch.

## Production behavior

- Investigate why the intended success path failed before exposing an error.
- Prefer retries, repair, durable state, health checks, and operational alerts
  when they preserve the product contract.
- Unrecoverable errors must fail clearly. Never fabricate data, conceal
  corruption, or report partial work as successful.
- A fallback is valid only when it preserves provider identity, billing,
  privacy, persistence, and output-quality expectations.
- Identify whether infrastructure is Remalt-managed or user-owned/BYOK before
  changing provider fallback behavior. BYOK failures remain BYOK failures unless
  the user opted into a managed fallback.
- For provider, media, and storage failures, check stale data, response shape,
  credentials, quota, headers, MIME type, size, configuration, retry timing,
  and legacy caches.
- Validate data-dependent fixes against production-shaped artifacts when safe.

## Database and release safety

- If a Supabase migration must be run, say so in capital letters.
- Do not commit migration-dependent code until the user confirms that migration
  ran, unless they explicitly authorize otherwise.
- Do not push to production without explicit approval for that change.
- If a change affects visible semantics, billing, provider identity,
  persistence, or data contracts, explain the tradeoff before pushing.
