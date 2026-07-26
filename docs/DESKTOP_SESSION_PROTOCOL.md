# Desktop Session Protocol

The renderer-free per-session host accepts Claude Code hooks and publishes only
privacy-minimal semantic state to one launcher-owned desktop overlay.

## Transport and authorization

The host binds to `127.0.0.1`. Every session gets a cryptographically random
32-byte base64url capability in `CLAUDE_EMOTE_CAPABILITY_TOKEN`. The launcher
passes it to the host, overlay, hook bridge, and Claude hook children through
their environments.

Every request except `GET /health` and loopback CORS preflight must send:

```http
Authorization: Bearer <session capability>
```

The capability must never appear in a URL, command line, log, state payload, or
diagnostic report. Missing or incorrect credentials receive `401`. The
unauthenticated health response says only whether a capability is required.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Unauthenticated process readiness, no session state |
| `POST /event` | Authenticated Claude hook input |
| `GET /state` | Authenticated current semantic snapshot |
| `GET /stream` | Authenticated server-sent state stream |
| `POST /overlay-ready` | Overlay acknowledges its first connected render |
| `GET /overlay-health` | Launcher waits for the readiness acknowledgement |

The overlay uses streaming `fetch`, not `EventSource`, because the request must
carry an authorization header. The client reconnects with bounded exponential
backoff, receives a fresh snapshot, and ignores stale sequence numbers.

## State shape

The authoritative contract is `src/shared/pet-session-state.ts`:

```ts
interface PetSessionState {
  sessionId: string;
  sequence: number;
  status:
    | "running"
    | "needs-input"
    | "ready"
    | "blocked"
    | "ended"
    | "disconnected";
  activity:
    | "greeting"
    | "idle"
    | "thinking"
    | "reading"
    | "writing"
    | "tooling"
    | "talking"
    | "compacting"
    | "failure";
  timestamp: number;
}
```

These are the only permitted fields. The server and client reject unknown
fields, so prompts, output, tool details, paths, configuration, and credentials
cannot accidentally cross the overlay boundary.

## Browser-origin policy

Browser requests are accepted only from loopback origins. Native and CLI
requests without `Origin` still require the bearer capability. Other browser
origins receive `403 origin_forbidden`.

## Development workflow

The normal integration path is the production-shaped one:

```powershell
npm run build
npm run overlay:package
$env:CLAUDE_EMOTE_DEBUG = "1"
node .\bin\claude-emote.cjs --resume
```

Use the fake-host and fake-overlay integration tests when debugging the wire
protocol. Do not put a capability into `--url`, query parameters, or copied
manual commands merely to make a browser tool connect.
