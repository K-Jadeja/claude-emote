# Desktop session local-auth gap

Date: 2026-07-27  
Status: fixed

## Impact

The developer-preview host bound only to loopback and restricted browser
origins, but `/event`, `/state`, and `/stream` had no per-session credential.
Another local process could therefore submit fake lifecycle events or read the
semantic state. The earlier manual overlay URL also encouraged putting
connection data in a query string.

## Root cause

The first overlay slice treated loopback binding and CORS as authentication.
CORS protects browser origins; it does not authenticate native local processes.
The standard `EventSource` API also cannot set an authorization header, which
made a query-token shortcut tempting.

## Fix

- Generate one random 32-byte base64url capability per launcher session.
- Pass it only through launcher-owned child environments.
- Require an exact bearer header for hook, state, stream, and readiness routes.
- Replace `EventSource` with a small streaming-`fetch` SSE client.
- Keep the token out of URLs, argv, logs, semantic payloads, and diagnostics.
- Leave only content-free `/health` unauthenticated for process readiness.

## Regression coverage

Tests prove missing and incorrect tokens return `401`, authenticated hooks and
SSE work, the overlay token appears only in its environment, stale/malformed
state is rejected, and launcher fallback removes all companion environment
values before starting Claude. Overlay readiness is acknowledged only after an
authoritative snapshot frame has decoded successfully.

## Repeatable rule

Loopback is a network boundary, not an identity boundary. Any new local route
that observes or changes a session must require the capability unless its
response is deliberately content-free process health.
