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
import type { AvatarOutputPolicy } from "./output-policy.js";

const MAX_BODY_BYTES = 256 * 1024; // matches bridge contract.
const REQUEST_TIMEOUT_MS = 5_000;

export interface AvatarServerOptions {
  instanceId: string;
  port: number;
  /** Called for every accepted event with the mapper reaction. */
  onEvent: (reaction: AvatarReaction, rawEvent: unknown) => void;
  /** Called for every accepted event with the raw event for talk-token forwarding. */
  onMessageDisplayDelta?: (content: string) => void;
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

/**
 * Build the HTTP server. Does NOT call listen() — the caller passes a
 * `port` and we listen in startServer() so the caller can introspect
 * the address if it asked for port 0.
 */
export function startServer(opts: AvatarServerOptions): Promise<AvatarServer> {
  return new Promise((resolve, reject) => {
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
        });
      }

      if (req.method !== "POST" || url.pathname !== "/event") {
        return writeJson(res, 404, { ok: false, error: "not_found" });
      }

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
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
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
