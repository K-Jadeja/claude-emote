#!/usr/bin/env node
/**
 * hook-bridge.ts
 *
 * Node-stdlib-only bridge executable invoked by Claude Code hooks.
 *
 * Contract (from the project specification):
 *   1. Read the complete hook JSON from stdin.
 *   2. Read CLAUDE_EMOTE_ENDPOINT from the environment.
 *   3. POST the unmodified event to the local endpoint.
 *   4. Use a very short connection and request timeout.
 *   5. Print nothing to stdout.
 *   6. Exit with status 0 even when the avatar server is unavailable.
 *   7. Log failures only when CLAUDE_EMOTE_DEBUG=1.
 *   8. Never return displayContent.
 *   9. Never block, deny, approve, or change Claude behaviour.
 *  10. Have no dependency other than Node's standard library.
 *
 * The compiled output (dist/claude/hook-bridge.js) is what the hooks.json
 * references. Because this file uses only `node:*` built-ins, the compiled
 * JavaScript can be run by Claude Code without a node_modules folder.
 */

import { request } from "node:http";
import { URL } from "node:url";
import { writeFileSync } from "node:fs";
import {
  buildCapabilityAuthorization,
  isSessionCapability,
} from "../shared/session-capability.js";

const REQUEST_TIMEOUT_MS = 1500;
const MAX_BODY_BYTES = 256 * 1024; // 256 KiB — well above any reasonable hook payload.
const STDIN_TIMEOUT_MS = 1500;

// Benchmark opt-in: when this env var is set, the bridge writes its own
// internal timing to a file so the benchmark script can distinguish
// "bridge logic time" from "node spawn + exit overhead".
const BRIDGE_TIMING_FILE = process.env.CLAUDE_EMOTE_BRIDGE_TIMING_FILE;
const bridgeStart = BRIDGE_TIMING_FILE ? Date.now() : 0;

const debug = process.env.CLAUDE_EMOTE_DEBUG === "1";

function dbg(msg: string): void {
  if (debug) {
    // stderr only — never stdout.
    process.stderr.write(`[claude-emote bridge] ${msg}\n`);
  }
}

/**
 * Read all of stdin up to MAX_BODY_BYTES. Resolves with a string buffer
 * even if the read times out (in which case we forward whatever we have).
 */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("end");
      process.stdin.removeAllListeners("error");
      resolve(value);
    };

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length >= MAX_BODY_BYTES) finish(buf);
    });
    process.stdin.on("end", () => finish(buf));
    process.stdin.on("error", () => finish(buf));

    setTimeout(() => finish(buf), STDIN_TIMEOUT_MS).unref();
  });
}

/**
 * POST a JSON body to the given endpoint. Awaits the response so the
 * server has time to receive the payload before the bridge exits; this
 * is required because Claude Code may consider the bridge "done" the
 * moment the process terminates. Resolves (never rejects) on every path.
 */
function postJson(endpoint: string, body: string): Promise<void> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch (err) {
      dbg(`invalid endpoint URL: ${(err as Error).message}`);
      resolve();
      return;
    }

    const capability = process.env.CLAUDE_EMOTE_CAPABILITY_TOKEN;
    const headers: Record<string, string | number> = {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body, "utf8"),
    };
    if (isSessionCapability(capability)) {
      headers.authorization = buildCapabilityAuthorization(capability);
    }
    const opts = {
      method: "POST",
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers,
      timeout: REQUEST_TIMEOUT_MS,
    };

    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const req = request(opts, (res) => {
      if ((res.statusCode ?? 500) >= 400) {
        dbg(`avatar server returned HTTP ${res.statusCode ?? "unknown"}`);
      }
      res.resume();
      res.on("end", done);
      res.on("error", done);
    });
    req.on("timeout", () => {
      dbg(`request to ${endpoint} timed out after ${REQUEST_TIMEOUT_MS}ms`);
      req.destroy();
      done();
    });
    req.on("error", (err) => {
      dbg(`request error: ${err.message}`);
      done();
    });

    try {
      req.end(body);
    } catch (err) {
      dbg(`request.end threw: ${(err as Error).message}`);
      done();
    }
  });
}

async function main(): Promise<void> {
  const endpoint = process.env.CLAUDE_EMOTE_ENDPOINT;
  if (!endpoint) {
    dbg("CLAUDE_EMOTE_ENDPOINT not set — nothing to do.");
    return;
  }

  const raw = await readStdin();
  if (!raw) {
    dbg("stdin empty — nothing to forward.");
    return;
  }

  // Forward the unmodified payload. We do not parse or rewrite it here; the
  // avatar server applies the event mapper.
  await postJson(endpoint, raw);
}

main().then(
  () => {
    if (BRIDGE_TIMING_FILE) {
      try {
        writeFileSync(
          BRIDGE_TIMING_FILE,
          JSON.stringify({ bridgeStart, bridgeEnd: Date.now() }) + "\n",
          { flag: "a" },
        );
      } catch {
        // Timing is best-effort; never break the bridge.
      }
    }
    process.exit(0);
  },
  (err) => {
    dbg(`bridge crashed: ${(err as Error).message}`);
    process.exit(0);
  },
);
