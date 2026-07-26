# Desktop Session Protocol

The desktop overlay consumes semantic session state from the existing
per-session avatar host. It never receives a complete Claude hook payload.

## State shape

The authoritative TypeScript contract is
`src/shared/pet-session-state.ts`:

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

These are the only permitted fields. Both server and client reject unknown
fields so a later refactor cannot accidentally copy prompt or tool data into
the overlay.

## Endpoints

The avatar host binds to `127.0.0.1` and exposes:

| Endpoint | Purpose |
| --- | --- |
| `GET /state` | Current semantic snapshot, with `Cache-Control: no-store` |
| `GET /stream` | Server-sent event stream |
| `POST /event` | Existing Claude hook input; not used by the desktop UI |
| `GET /health` | Existing launcher readiness check |

`/stream` sends:

1. an SSE retry interval;
2. one `snapshot` event containing the authoritative current state;
3. a `state` event after each accepted Claude reaction;
4. a comment heartbeat every 15 seconds.

Each state carries a monotonically increasing `sequence`. The UI ignores older
updates. Reconnection creates a new EventSource, and the server starts it with a
fresh snapshot, so the UI does not have a fetch-then-subscribe race.

## Privacy boundary

The tracker reads only:

- `hook_event_name`;
- `session_id`;
- the already-mapped `AvatarReaction`.

It does not retain or emit:

- prompts or assistant output;
- tool names, arguments, or results;
- project paths;
- environment values;
- model/provider configuration;
- credentials.

## Browser-origin policy

Native and CLI requests without an `Origin` header are accepted from the
loopback listener. Browser requests to `/state` and `/stream` are accepted only
when their HTTP origin host is `127.0.0.1`, `localhost`, or `[::1]`. Other
origins receive `403 origin_forbidden`.

This prevents an arbitrary website from reading the session state through the
browser. Before distributing a generalized multi-session daemon, add a
per-session capability token as a second local-process boundary.

## Running a live development window

Build the runtime:

```powershell
npm run build
npm run overlay:build
npm run overlay:setup
```

In PowerShell window 1, start an avatar host on a free port:

```powershell
node .\dist\host\avatar-process.js `
  --port=43123 `
  --instance=desktop-dev `
  "--parentPid=$PID"
```

In PowerShell window 2, launch the Neutralino binary with the encoded event
endpoint:

```powershell
desktop\bin\neutralino-win_x64.exe `
  --load-dir-res `
  --path=desktop `
  "--url=/?endpoint=http%3A%2F%2F127.0.0.1%3A43123%2Fevent"
```

In PowerShell window 3, start Claude with the same endpoint and the local
plugin:

```powershell
$env:CLAUDE_EMOTE_ENDPOINT = "http://127.0.0.1:43123/event"
claude --plugin-dir (Resolve-Path .)
```

The desktop client normalizes `/event`, `/state`, `/stream`, or the base URL to
the stream endpoint. Non-loopback and unexpected paths fail clearly.

This three-window procedure is a contributor workflow. The intended product
flow is one `claude-emote` command; see `docs/USER_FLOW.md`.
