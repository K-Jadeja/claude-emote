/**
 * avatar-server.ts
 *
 * Tiny HTTP server bound only to 127.0.0.1. Accepts Claude Code hook
 * events at /event, exposes /health for the launcher handshake, and
 * delegates state decisions to the event mapper.
 *
 * Hard rules:
 *   - Bound only to 127.0.0.1.
 *   - Rejects bodies larger than MAX_BODY_BYTES.
 *   - Never throws to the caller — every handler returns JSON.
 *   - All diagnostic logging goes through the supplied
 *     `AvatarOutputPolicy` so the visual-pane contract can suppress
 *     event-log writes from the writing surface.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mapEventSafe, type AvatarReaction } from "../claude/event-mapper.js";
import type { PetSessionState } from "../shared/pet-session-state.js";
import type { AvatarOutputPolicy } from "./output-policy.js";
import { isCapabilityAuthorized } from "./session-auth.js";
import type { WindowsTerminalFocus } from "./focus-windows-terminal.js";

const MAX_BODY_BYTES = 256 * 1024; // matches bridge contract.
const REQUEST_TIMEOUT_MS = 5_000;
const SSE_HEARTBEAT_MS = 15_000;

export interface PetSessionStateSource {
  getSnapshot(): PetSessionState;
  subscribe(listener: (state: PetSessionState) => void): () => void;
}

export interface AvatarServerOptions {
  instanceId: string;
  port: number;
  /** Called for every accepted event with the mapper reaction. */
  onEvent: (reaction: AvatarReaction, rawEvent: unknown) => void;
  /** Called for every accepted event with the raw event for talk-token forwarding. */
  onMessageDisplayDelta?: (content: string) => void;
  /** Privacy-minimal snapshot and update stream consumed by the desktop pet. */
  sessionState: PetSessionStateSource;
  /**
   * When supplied, every hook/state/overlay endpoint requires an exact Bearer
   * token. The optional form preserves direct legacy terminal harnesses; the
   * launcher-owned desktop host always supplies one.
   */
  capabilityToken?: string;
  /**
   * Output policy for every diagnostic the server emits. When the
   * server runs inside a Windows Terminal visual pane the policy
   * suppresses the event-log writes from the writing surface; when
   * it runs in attached / test / validation modes the policy
   * forwards them to stderr exactly as before. The policy is
   * mandatory so the server never reaches for
   * process.stdout / process.stderr directly.
   */
  policy: AvatarOutputPolicy;
  /**
   * Optional WT-pane focuser. When supplied, the `POST /focus`
   * route attempts to bring the originating Windows Terminal
   * pane to the foreground. When absent, `/focus` is a silent
   * 204 no-op (host running in attached / test / non-WT modes).
   */
  focuser?: WindowsTerminalFocus;
}

export interface AvatarServer {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

/**
 * Parse a request body as JSON up to MAX_BODY_BYTES. Resolves with the
 * parsed object (or null on parse error / empty body).
 */
function readJsonBody(req: IncomingMessage): Promise<unknown | null> {
  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const finish = (value: unknown | null) => {
      if (settled) return;
      settled = true;
      req.removeAllListeners("data");
      req.removeAllListeners("end");
      req.removeAllListeners("error");
      resolve(value);
    };
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      buf += c;
      if (buf.length > MAX_BODY_BYTES) finish(null);
    });
    req.on("end", () => {
      if (!buf) return finish(null);
      try {
        finish(JSON.parse(buf));
      } catch {
        finish(null);
      }
    });
    req.on("error", () => finish(null));
    setTimeout(() => finish(null), REQUEST_TIMEOUT_MS).unref();
  });
}

function writeJson(res: ServerResponse, code: number, obj: unknown): void {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(obj));
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

/**
 * Browser reads are restricted to another loopback HTTP origin. Requests
 * without Origin remain available to the local CLI and integration tests.
 */
function applyStateCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (!isLoopbackOrigin(origin)) {
    writeJson(res, 403, { ok: false, error: "origin_forbidden" });
    return false;
  }
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "Origin");
  return true;
}

function requireCapability(
  req: IncomingMessage,
  res: ServerResponse,
  expectedToken: string | undefined,
): boolean {
  if (isCapabilityAuthorized(req.headers.authorization, expectedToken)) {
    return true;
  }
  res.setHeader("www-authenticate", "Bearer");
  writeJson(res, 401, { ok: false, error: "unauthorized" });
  return false;
}

function isBrowserEndpoint(pathname: string): boolean {
  return [
    "/state",
    "/stream",
    "/overlay-ready",
    "/overlay-health",
    "/focus",
  ].includes(pathname);
}

function writeSseEvent(
  res: ServerResponse,
  eventName: "snapshot" | "state",
  state: PetSessionState,
): void {
  res.write(`id: ${state.sequence}\n`);
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(state)}\n\n`);
}

/**
 * Build the HTTP server. Does NOT call listen() — the caller passes a
 * `port` and we listen in startServer() so the caller can introspect
 * the address if it asked for port 0.
 */
export function startServer(opts: AvatarServerOptions): Promise<AvatarServer> {
  return new Promise((resolve, reject) => {
    const stateClients = new Set<ServerResponse>();
    let overlayReady = false;
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/health") {
        return writeJson(res, 200, {
          ok: true,
          instanceId: opts.instanceId,
          // `opts.port` is mutated to the actual bound port inside the
          // server.listen() callback below. After listen resolves this is
          // the OS-assigned port (which may differ from the requested one
          // when the launcher passed --port=0).
          port: opts.port,
          capabilityRequired: opts.capabilityToken !== undefined,
        });
      }

      if (req.method === "OPTIONS" && isBrowserEndpoint(url.pathname)) {
        if (!applyStateCors(req, res)) return;
        res.statusCode = 204;
        res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
        res.setHeader("access-control-allow-headers", "authorization");
        res.setHeader("access-control-max-age", "600");
        res.end();
        return;
      }

      if (req.method === "GET" && url.pathname === "/state") {
        if (!applyStateCors(req, res)) return;
        if (!requireCapability(req, res, opts.capabilityToken)) return;
        res.setHeader("cache-control", "no-store");
        return writeJson(res, 200, opts.sessionState.getSnapshot());
      }

      if (req.method === "GET" && url.pathname === "/stream") {
        if (!applyStateCors(req, res)) return;
        if (!requireCapability(req, res, opts.capabilityToken)) return;
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-store");
        res.setHeader("connection", "keep-alive");
        res.setHeader("x-accel-buffering", "no");
        res.flushHeaders();
        res.write("retry: 1000\n\n");
        stateClients.add(res);

        const unsubscribe = opts.sessionState.subscribe((state) => {
          if (!res.writableEnded) writeSseEvent(res, "state", state);
        });
        const heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(": heartbeat\n\n");
        }, SSE_HEARTBEAT_MS);
        heartbeat.unref();
        let cleanedUp = false;
        const cleanup = () => {
          if (cleanedUp) return;
          cleanedUp = true;
          clearInterval(heartbeat);
          unsubscribe();
          stateClients.delete(res);
        };
        req.once("close", cleanup);
        res.once("close", cleanup);
        writeSseEvent(res, "snapshot", opts.sessionState.getSnapshot());
        return;
      }

      if (req.method === "POST" && url.pathname === "/overlay-ready") {
        if (!applyStateCors(req, res)) return;
        if (!requireCapability(req, res, opts.capabilityToken)) return;
        overlayReady = true;
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method === "GET" && url.pathname === "/overlay-health") {
        if (!applyStateCors(req, res)) return;
        if (!requireCapability(req, res, opts.capabilityToken)) return;
        return writeJson(res, overlayReady ? 200 : 503, {
          ok: overlayReady,
          instanceId: opts.instanceId,
        });
      }

      if (req.method === "POST" && url.pathname === "/focus") {
        if (!applyStateCors(req, res)) return;
        if (!requireCapability(req, res, opts.capabilityToken)) return;
        // Side-effect-bounded: never returns state, never throws, 204 either way.
        if (opts.focuser) {
          const outcome = await opts.focuser.focus();
          opts.policy.writeDiagnostic(
            `[avatar-server] /focus: ${JSON.stringify(outcome)}\n`,
          );
        }
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method !== "POST" || url.pathname !== "/event") {
        return writeJson(res, 404, { ok: false, error: "not_found" });
      }
      if (!requireCapability(req, res, opts.capabilityToken)) return;

      const body = await readJsonBody(req);
      if (body === null) {
        return writeJson(res, 400, { ok: false, error: "invalid_json" });
      }
      const reaction = mapEventSafe(body);
      try {
        opts.onEvent(reaction, body);
        // Forward MessageDisplay delta tokens so the Animator can drive the mouth.
        if (
          opts.onMessageDisplayDelta &&
          reaction.state === "talk" &&
          reaction.talkToken
        ) {
          opts.onMessageDisplayDelta(reaction.talkToken);
        }
        opts.policy.writeDiagnostic(
          `[avatar-server] event: name=${(body as { hook_event_name?: string })?.hook_event_name ?? "?"} reaction=${JSON.stringify(reaction)}\n`,
        );
        return writeJson(res, 200, { ok: true, reaction });
      } catch (err) {
        opts.policy.writeDiagnostic(
          `[avatar-server] onEvent threw: ${(err as Error).message}\n`,
        );
        return writeJson(res, 500, { ok: false, error: "internal" });
      }
    });

    server.on("error", (err) => {
      opts.policy.writeDiagnostic(`[avatar-server] server error: ${err.message}\n`);
      reject(err);
    });

    server.listen(opts.port, "127.0.0.1", () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : opts.port;
      // Mutate opts.port so the /health handler (registered earlier in
      // this scope) reads the actual bound port even when the caller
      // requested --port=0.
      opts.port = actualPort;
      const port = actualPort;
      const url = `http://127.0.0.1:${port}`;
      opts.policy.writeDiagnostic(`[avatar-server] listening on ${url}\n`);
      resolve({
        server,
        port,
        url,
        close: () => {
          for (const client of stateClients) client.end();
          stateClients.clear();
          return new Promise<void>((r) => {
            server.close(() => r());
          });
        },
      });
    });
  });
}

/**
 * Wait for the server to return 200 from /health, up to timeoutMs.
 * Resolves true on success, false on timeout / connection refused.
 */
export async function waitForHealth(url: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = new URL("/health", url).toString();
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
