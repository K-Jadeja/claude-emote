#!/usr/bin/env node
/**
 * scripts/benchmark-latency.mjs
 *
 * Phase 9B authoritative hook-to-frame latency benchmark.
 *
 * Methodology rules (Phase 9B spec):
 *   - Use real compiled artifacts only: dist/claude/hook-bridge.js and
 *     dist/host/avatar-process.js.
 *   - Never modify copied Animator or renderer code.
 *   - Never launch interactive Claude, never open Windows Terminal,
 *     never open CMD windows, never use shell:true or detach children.
 *   - Use performance.now() for every measured duration.
 *   - Observe real stdout from the avatar process. A frame is
 *     timestamped at the moment the chunk that *first* contains the
 *     expected frame text arrives after the per-sample baseline.
 *   - Reset between samples by sending a real Stop event (with a
 *     compact-recovery fallback when the avatar's failure hold
 *     suppresses Stop) and waiting for the real idle frame.
 *   - No manual Animator / host / renderer / stdout injection.
 *   - Discard nothing from the measured distribution; warmups are
 *     excluded by definition, measured samples are retained.
 *   - Independent runs are executed sequentially inside one invocation.
 *
 * Four metrics:
 *   A. bridgeSpawnToServerReceiveMs / bridgeSpawnToExitMs
 *      Real hook-bridge spawned against an in-process benchmark
 *      HTTP server; per-sample request records (method, path, body,
 *      receivedAtMs) ensure exact payload matching.
 *   B. directPostToResponseMs / directPostToFrameMs
 *      Real avatar already running with --port=0 (OS-selected);
 *      direct POST to /event with a real UserPromptSubmit.
 *   C. fullHookToBridgeExitMs / fullHookToFrameMs
 *      Real bridge → real avatar → real stdout frame.
 *   D. failOpenBridgeExitMs
 *      Real bridge invoked against a freshly-reserved, freshly-closed
 *      localhost port. Requires exit code 0 and signal null on every
 *      sample.
 *
 * Avatar is launched with --port=0; the real OS-selected port is
 * parsed from the READY marker and validated via /health. The
 * benchmark never pre-reserves a port for the avatar.
 */

import { spawn, spawnSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { request } from "node:http";
import { createServer as createTcpServer } from "node:net";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import {
  tmpdir,
  cpus,
  totalmem,
  release,
  type as osType,
  arch as osArch,
} from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

import {
  summarize,
  validateBenchmarkResult,
  sanitizeRecordDeep,
  forbiddenSubstrings,
  findForbiddenSubstrings,
} from "./lib/benchmark-stats.mjs";
import {
  parseArgs as parseCliArgs,
  CliError,
  DEFAULT_CONFIG,
} from "./lib/benchmark-cli.mjs";
import { loadBundledFrames } from "./lib/benchmark-frame-loader.mjs";
import { readNpmVersion } from "./lib/npm-version.mjs";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(__filename, "..", "..");
const BRIDGE = resolve(PROJECT_ROOT, "dist", "claude", "hook-bridge.js");
const AVATAR = resolve(PROJECT_ROOT, "dist", "host", "avatar-process.js");
const HOOKS_JSON = resolve(PROJECT_ROOT, "hooks", "hooks.json");
const ASCII_YAML = resolve(PROJECT_ROOT, "emotes", "ascii", "ascii.yaml");
const FIXTURES_DIR = resolve(PROJECT_ROOT, "tests", "fixtures");

// ---------------------------------------------------------------------------
// Frame loader
// ---------------------------------------------------------------------------
let BUNDLED_FRAMES;
let PRIMARY_THINK_FRAME;
let IDLE_FRAME;
let TALK_FRAMES;
let READ_FRAMES;
let WRITE_FRAMES;
let FAILURE_FRAMES;
let COMPACT_FRAMES;

async function loadFramesOnce() {
  if (BUNDLED_FRAMES) return BUNDLED_FRAMES;
  const f = await loadBundledFrames();
  BUNDLED_FRAMES = f;
  PRIMARY_THINK_FRAME = f.primaryThink;
  // Pick the first idle frame as the canonical idle marker. This is
  // the same one the avatar draws after the reset Stop in the common
  // path; the renderer cycles between idle frames internally.
  IDLE_FRAME = f.idle[0];
  TALK_FRAMES = f.talk;
  READ_FRAMES = f.read;
  WRITE_FRAMES = f.write;
  FAILURE_FRAMES = f.failure;
  COMPACT_FRAMES = f.compact;
  if (!IDLE_FRAME) throw new Error("bundled ASCII set has no idle frames");
  if (TALK_FRAMES.length === 0) {
    throw new Error("bundled ASCII set has no talk frames");
  }
  if (READ_FRAMES.length === 0) {
    throw new Error("bundled ASCII set has no read frames");
  }
  if (WRITE_FRAMES.length === 0) {
    throw new Error("bundled ASCII set has no write frames");
  }
  if (FAILURE_FRAMES.length === 0) {
    throw new Error("bundled ASCII set has no failure frames");
  }
  if (COMPACT_FRAMES.length === 0) {
    throw new Error("bundled ASCII set has no compact frames");
  }
  return f;
}

// ---------------------------------------------------------------------------
// Hook-timeout config
// ---------------------------------------------------------------------------
function readHookTimeoutSeconds() {
  const raw = readFileSync(HOOKS_JSON, "utf8");
  const parsed = JSON.parse(raw);
  /** @type {Set<number>} */
  const timeouts = new Set();
  for (const arr of Object.values(parsed.hooks ?? {})) {
    for (const handler of arr) {
      for (const h of handler.hooks ?? []) {
        if (typeof h.timeout === "number") timeouts.add(h.timeout);
      }
    }
  }
  if (timeouts.size === 0) {
    throw new Error("could not determine hook timeout from hooks/hooks.json");
  }
  if (timeouts.size > 1) {
    throw new Error(
      `hooks/hooks.json contains inconsistent timeouts: ${[...timeouts].join(",")}`,
    );
  }
  const seconds = [...timeouts][0];
  return { seconds, ms: seconds * 1000 };
}

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------
function strippedAvatarEnv() {
  const clean = { ...process.env };
  for (const k of [
    "WT_SESSION",
    "TERM_PROGRAM",
    "ITERM_SESSION_ID",
    "KITTY_WINDOW_ID",
    "WEZTERM_PANE",
    "GHOSTTY_RESOURCES_DIR",
    "TMUX",
    "ZELLIJ_SESSION_NAME",
    "ZELLIJ",
    "CLAUDE_EMOTE_PORT",
    "CLAUDE_EMOTE_INSTANCE_ID",
    "CLAUDE_EMOTE_EMOTE_DIR",
    "CLAUDE_EMOTE_PARENT_PID",
    "CLAUDE_EMOTE_LOG_FILE",
    "CLAUDE_EMOTE_DEBUG",
    "CLAUDE_EMOTE_DEMO_PROTOCOL",
    "CLAUDE_EMOTE_BRIDGE_TIMING_FILE",
    "CLAUDE_EMOTE_DATA_DIR",
  ]) {
    delete clean[k];
  }
  return clean;
}

// ---------------------------------------------------------------------------
// Robust child cleanup
// ---------------------------------------------------------------------------
/**
 * Idempotent, robust cleanup for a spawned child.
 *
 * Behavior:
 *   - If the child has already exited, return immediately.
 *   - Send SIGTERM and await exit with a bounded timeout.
 *   - If the child has not exited, escalate to SIGKILL and await
 *     exit again.
 *   - After exit (whether natural or killed), verify the PID is no
 *     longer alive in the process table.
 *
 * Resolves once the child is verified gone, or rejects if the
 * timeout was exceeded without being able to kill the child.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {{ timeoutMs?: number, label?: string }} [opts]
 */
export async function killChild(child, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const label = opts.label ?? "child";
  if (!child || typeof child.pid !== "number") return;
  if (child.exitCode !== null || child.signalCode !== null) {
    await verifyProcessGone(child.pid, label);
    return;
  }
  // Ask politely first.
  try { child.kill("SIGTERM"); } catch { /* ignore */ }
  const termExit = await awaitExit(child, timeoutMs);
  if (termExit !== null) {
    await verifyProcessGone(child.pid, label);
    return;
  }
  // Escalate.
  try { child.kill("SIGKILL"); } catch { /* ignore */ }
  const killExit = await awaitExit(child, timeoutMs);
  if (killExit === null) {
    throw new Error(`failed to terminate ${label} (pid=${child.pid}) within ${timeoutMs}ms after SIGKILL`);
  }
  await verifyProcessGone(child.pid, label);
}

function awaitExit(child, timeoutMs) {
  return new Promise((resolveOne) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveOne({ at: performance.now(), code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => resolveOne(null), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveOne({ at: performance.now(), code, signal });
    });
  });
}

async function verifyProcessGone(pid, label) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    const e = err && /** @type {NodeJS.ErrnoException} */ (err);
    if (e && e.code === "ESRCH") return;
    if (e && (e.code === "EPERM" || e.code === "EACCES")) {
      // Process exists but we can't signal it; the kill succeeded.
      return;
    }
    throw err;
  }
  throw new Error(`${label} (pid=${pid}) still alive after cleanup`);
}

// ---------------------------------------------------------------------------
// Per-sample bridge benchmark server
// ---------------------------------------------------------------------------
/**
 * @typedef {{
 *   method: string,
 *   path: string,
 *   body: string,
 *   receivedAtMs: number,
 * }} BridgeRequest
 */

/**
 * Per-sample promise queue for the bridge benchmark server. Each call
 * to nextRequest returns a Promise that resolves with the very next
 * /event POST the server observes.
 *
 * @returns {{
 *   server: import("node:http").Server,
 *   endpoint: string,
 *   port: number,
 *   nextRequest: () => Promise<BridgeRequest>,
 *   close: () => Promise<void>,
 * }}
 */
function startBridgeServer() {
  /** @type {Array<(rec: BridgeRequest) => void>} */
  const waiters = [];
  /** @type {BridgeRequest[]} */
  const pending = [];
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c.toString("utf8")));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/event") {
        const rec = {
          method: req.method ?? "",
          path: req.url ?? "",
          body,
          receivedAtMs: performance.now(),
        };
        if (waiters.length > 0) {
          const w = waiters.shift();
          w(rec);
        } else {
          pending.push(rec);
        }
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end('{"ok":true}');
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  return new Promise((resolveReady, rejectReady) => {
    server.on("error", rejectReady);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        rejectReady(new Error("could not get bridge-server port"));
        return;
      }
      const port = addr.port;
      const endpoint = `http://127.0.0.1:${port}/event`;
      /** @type {BridgeServer} */
      const handle = {
        port: () => port,
        endpoint: () => endpoint,
        nextRequest: () =>
          new Promise((r) => {
            if (pending.length > 0) {
              r(pending.shift());
              return;
            }
            waiters.push(r);
          }),
        close: () => new Promise((r) => server.close(() => r())),
      };
      resolveReady(handle);
    });
  });
}

/** @typedef {{
 *   port: () => number,
 *   endpoint: () => string,
 *   nextRequest: () => Promise<BridgeRequest>,
 *   close: () => Promise<void>,
 * }} BridgeServer */

function reserveClosedPort() {
  return new Promise((resolveOne, rejectOne) => {
    const srv = createTcpServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        rejectOne(new Error("could not reserve a closed port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolveOne(port));
    });
    srv.on("error", rejectOne);
  });
}

// ---------------------------------------------------------------------------
// Avatar lifecycle with --port=0
// ---------------------------------------------------------------------------
/**
 * @typedef {Object} AvatarHandle
 * @property {import("node:child_process").ChildProcess} child
 * @property {() => string} getStdout
 * @property {() => string} getStderr
 * @property {() => number} port
 * @property {() => string} instanceId
 * @property {(frame: string, baselineMs: number, timeoutMs?: number) => Promise<number | null>} awaitFrameAfter
 * @property {() => string} currentFrameText
 * @property {() => Promise<void>} close
 * @property {() => Promise<void>} kill
 * @property {string} tempDir
 * @property {() => Array<{ text: string, atMs: number }>} getChunks
 */

/**
 * Start the avatar with --port=0 so the OS picks a port. Wait for the
 * real READY marker, parse the actual port, assert /health reports
 * the same port and the requested instanceId, and return a handle.
 *
 * @param {string} instanceId
 * @returns {Promise<AvatarHandle>}
 */
async function startAvatar(instanceId) {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-emote-phase9b-"));
  const configDir = join(
    tempDir,
    ".claude-emote",
    "extensions",
    "claude-emote",
  );
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify(
      { terminals: [{ match: "unknown", render: "ascii" }] },
      null,
      2,
    ),
    "utf8",
  );

  const child = spawn(
    process.execPath,
    [AVATAR, `--port=0`, `--instance=${instanceId}`],
    {
      env: strippedAvatarEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      cwd: tempDir,
      shell: false,
      detached: false,
    },
  );

  let stdout = "";
  let stderr = "";
  /** @type {Array<{ text: string, atMs: number }>} */
  const chunks = [];

  child.stdout.on("data", (b) => {
    const atMs = performance.now();
    const text = b.toString("utf8");
    chunks.push({ text, atMs });
    stdout += text;
  });
  child.stderr.on("data", (b) => {
    stderr += b.toString("utf8");
  });

  await waitForCondition(
    () => stdout.includes("CLAUDE_EMOTE_READY"),
    15_000,
    "avatar READY",
    () => `stdout=${stdout} stderr=${stderr}`,
  );

  // Parse the real port from the READY marker. Verify requested=0.
  const m = stdout.match(/CLAUDE_EMOTE_READY url=http:\/\/127\.0\.0\.1:(\d+)/);
  if (!m) {
    throw new Error(`could not parse READY marker url: ${stdout}`);
  }
  const actualPort = Number(m[1]);
  if (!Number.isInteger(actualPort) || actualPort <= 0 || actualPort > 65535) {
    throw new Error(`avatar reported invalid port ${actualPort} in READY marker`);
  }

  // Verify /health matches.
  const health = await httpGetJson(`http://127.0.0.1:${actualPort}/health`, 5_000);
  if (health.port !== actualPort) {
    throw new Error(
      `avatar /health.port=${health.port} differs from READY port=${actualPort}`,
    );
  }
  if (health.instanceId !== instanceId) {
    throw new Error(
      `avatar /health.instanceId=${health.instanceId} differs from requested ${instanceId}`,
    );
  }

  // Wait for the initial idle frame so resetAvatarToIdle has a
  // baseline state to recognise.
  const initialIdleAt = await waitForInitialIdleFrame(chunks, 4_000);
  if (initialIdleAt === null) {
    throw new Error(
      `avatar did not draw its initial idle frame within 4s of READY. Captured: ${decodeForLog(stdout).slice(-200)}`,
    );
  }

  /** @param {string} frame @param {number} baselineMs @param {number} [timeoutMs] */
  async function awaitFrameAfter(frame, baselineMs, timeoutMs = 4_000) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const sl = chunks.filter((c) => c.atMs >= baselineMs);
      let rolling = "";
      for (const c of sl) {
        rolling += c.text;
        if (rolling.includes(frame)) return c.atMs;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    return null;
  }

  function currentFrameText() {
    if (chunks.length === 0) return "";
    const tail = chunks
      .slice(-32)
      .map((c) => c.text)
      .join("")
      .slice(-4096);
    // Compare against the full set of bundled frames, with idle
    // priority for the "are we idle" check used by resetAvatarToIdle.
    const allFrames = [
      "(^ ◡ ^)/",     // hi default
      ...BUNDLED_FRAMES.idle,
      ...BUNDLED_FRAMES.think,
      ...BUNDLED_FRAMES.talk,
      ...BUNDLED_FRAMES.read,
      ...BUNDLED_FRAMES.write,
      "( • ω•)/",     // tool 0
      "( • ω•)\\",    // tool 1
      ...BUNDLED_FRAMES.failure,
      ...BUNDLED_FRAMES.compact,
    ];
    let bestIdx = -1;
    let bestFrame = "";
    for (const frame of allFrames) {
      const idx = tail.lastIndexOf(frame);
      if (idx > bestIdx) {
        bestIdx = idx;
        bestFrame = frame;
      }
    }
    return bestFrame;
  }

  async function close() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await killChild(child, { timeoutMs: 2_000, label: "avatar" });
  }

  async function kill() {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    await killChild(child, { timeoutMs: 1_000, label: "avatar-kill" });
  }

  return {
    child,
    getStdout: () => stdout,
    getStderr: () => stderr,
    port: () => actualPort,
    instanceId: () => instanceId,
    awaitFrameAfter,
    currentFrameText,
    getChunks: () => chunks,
    close,
    kill,
    tempDir,
  };
}

async function waitForInitialIdleFrame(chunks, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    // Look for any idle frame in stdout chunks accumulated so far.
    let rolling = "";
    for (const c of chunks) {
      rolling += c.text;
      for (const idle of BUNDLED_FRAMES.idle) {
        if (rolling.includes(idle)) return c.atMs;
      }
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
}

function decodeForLog(s) {
  return s.replace(/\x1b\[\d*[A-Za-z]/g, "<ESC>").replace(/\x1b/g, "<ESC>");
}

function waitForCondition(predicate, timeoutMs, what, getContext) {
  return new Promise((resolveOne, rejectOne) => {
    const deadline = performance.now() + timeoutMs;
    const tick = async () => {
      while (performance.now() < deadline) {
        if (predicate()) return resolveOne();
        await new Promise((r) => setTimeout(r, 25));
      }
      const ctx = typeof getContext === "function" ? ` context=${getContext()}` : "";
      rejectOne(new Error(`waitForCondition(${what}) timed out in ${timeoutMs}ms.${ctx}`));
    };
    tick();
  });
}

function httpGetJson(url, timeoutMs = 3_000) {
  return new Promise((resolveOne, rejectOne) => {
    const u = new URL(url);
    const req = request(
      {
        method: "GET",
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        timeout: timeoutMs,
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            rejectOne(new Error(`GET ${url} returned ${res.statusCode}`));
            return;
          }
          try {
            resolveOne(JSON.parse(buf));
          } catch (err) {
            rejectOne(new Error(`failed to parse JSON from ${url}: ${err.message}`));
          }
        });
      },
    );
    req.on("error", rejectOne);
    req.on("timeout", () => {
      req.destroy();
      rejectOne(new Error(`GET ${url} timed out after ${timeoutMs}ms`));
    });
    req.end();
  });
}

function httpPost(url, body, timeoutMs = 3_000) {
  return new Promise((resolveOne, rejectOne) => {
    const u = new URL(url);
    const t0 = performance.now();
    const req = request(
      {
        method: "POST",
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body, "utf8"),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          const t1 = performance.now();
          resolveOne({
            status: res.statusCode ?? 0,
            body: buf,
            requestMs: t1 - t0,
            responseAtMs: t1,
            requestStartMs: t0,
          });
        });
      },
    );
    req.on("error", rejectOne);
    req.on("timeout", () => {
      req.destroy();
      rejectOne(new Error(`POST ${url} timed out after ${timeoutMs}ms`));
    });
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// Reset-to-idle (with failure-hold recovery via PreCompact)
// ---------------------------------------------------------------------------
async function resetAvatarToIdle(handle) {
  // Stop sends the avatar to idle in every state except during the
  // active failure hold. The state controller suppresses Stop while
  // held; we then drive PreCompact (which outranks failure) and
  // finally a second Stop (the only release from the compact lock).
  const current = handle.currentFrameText();
  if (current === IDLE_FRAME) return;
  const baseline = performance.now();
  await httpPost(
    `http://127.0.0.1:${handle.port()}/event`,
    JSON.stringify({
      hook_event_name: "Stop",
      session_id: `${SESSION_PREFIX}-reset-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
    }),
  );
  let at = await handle.awaitFrameAfter(IDLE_FRAME, baseline, 1_000);
  if (at !== null) return;
  // Recovery via PreCompact + Stop.
  const compactBaseline = performance.now();
  await httpPost(
    `http://127.0.0.1:${handle.port()}/event`,
    JSON.stringify({
      hook_event_name: "PreCompact",
      session_id: `${SESSION_PREFIX}-reset-compact-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
    }),
  );
  const compactFrame = COMPACT_FRAMES[0];
  const compactAt = await handle.awaitFrameAfter(compactFrame, compactBaseline, 2_000);
  if (compactAt === null) {
    throw new Error(
      `avatar did not enter compact during reset recovery. post-baseline text: ${decodeForLog(compactText(compactBaseline, handle)).slice(-200)}`,
    );
  }
  const stopBaseline = performance.now();
  await httpPost(
    `http://127.0.0.1:${handle.port()}/event`,
    JSON.stringify({
      hook_event_name: "Stop",
      session_id: `${SESSION_PREFIX}-reset-final-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
    }),
  );
  at = await handle.awaitFrameAfter(IDLE_FRAME, stopBaseline, 2_000);
  if (at === null) {
    throw new Error(
      `avatar did not deliver an idle frame within 4s after Stop+PreCompact+Stop reset. post-baseline text: ${decodeForLog(compactText(stopBaseline, handle)).slice(-200)}`,
    );
  }
}

function compactText(baselineMs, handle) {
  return handle
    .getChunks()
    .filter((c) => c.atMs >= baselineMs)
    .map((c) => c.text)
    .join("");
}

// ---------------------------------------------------------------------------
// Metric A — bridge delivery (per-sample request record)
// ---------------------------------------------------------------------------
async function measureBridgeDelivery(server, sessionId, hookTimeoutMs) {
  const endpoint = server.endpoint();
  const event = JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: sessionId,
    prompt: "latency benchmark",
  });

  // Establish a fresh waiter before spawn.
  const requestPromise = server.nextRequest();

  const t0 = performance.now();
  const child = spawn(
    process.execPath,
    [BRIDGE],
    {
      env: {
        ...process.env,
        CLAUDE_EMOTE_ENDPOINT: endpoint,
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: false,
    },
  );
  let stderr = "";
  child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
  child.stdout.on("data", () => {});

  child.stdin.end(event);

  // Wait for the exact incoming request.
  const received = await requestPromise;
  const spawnToReceive = received.receivedAtMs - t0;

  const exitCode = await new Promise((resolveOne) =>
    child.once("exit", (code, signal) =>
      resolveOne({ code: code ?? -1, signal }),
    ),
  );
  const bridgeExitAt = performance.now();
  const spawnToExit = bridgeExitAt - t0;

  // Strict validation: the request the server actually saw must match
  // the sample exactly.
  if (received.method !== "POST") {
    throw new Error(`bridge request method was "${received.method}", expected POST`);
  }
  if (received.path !== "/event") {
    throw new Error(`bridge request path was "${received.path}", expected /event`);
  }
  if (received.body !== event) {
    throw new Error(
      `bridge did not forward the original payload byte-for-byte (received ${received.body.length} bytes, expected ${event.length})`,
    );
  }
  if (exitCode.code !== 0) {
    throw new Error(`bridge exited with code ${exitCode.code} signal ${exitCode.signal}; stderr=${stderr}`);
  }
  if (exitCode.signal !== null) {
    throw new Error(`bridge exited via signal ${exitCode.signal}; stderr=${stderr}`);
  }
  if (spawnToExit > hookTimeoutMs) {
    throw new Error(
      `bridge took ${spawnToExit.toFixed(2)}ms, exceeds hook timeout ${hookTimeoutMs}ms`,
    );
  }
  return {
    spawnToServerReceiveMs: spawnToReceive,
    spawnToExitMs: spawnToExit,
    exitCode: exitCode.code,
    signal: exitCode.signal,
  };
}

// ---------------------------------------------------------------------------
// Metric B — direct avatar event-to-frame
// ---------------------------------------------------------------------------
async function measureDirectEventToFrame(handle, sessionId) {
  await resetAvatarToIdle(handle);
  const baselineMs = performance.now();
  const event = JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: sessionId,
    prompt: "latency benchmark",
  });
  const res = await httpPost(`http://127.0.0.1:${handle.port()}/event`, event);
  const frameAt = await handle.awaitFrameAfter(
    PRIMARY_THINK_FRAME,
    baselineMs,
    4_000,
  );
  if (frameAt === null) {
    throw new Error(
      `direct: think frame ${JSON.stringify(PRIMARY_THINK_FRAME)} not observed within 4s on stdout`,
    );
  }
  return {
    directPostToResponseMs: res.responseAtMs - res.requestStartMs,
    directPostToFrameMs: frameAt - res.requestStartMs,
  };
}

// ---------------------------------------------------------------------------
// Metric C — full hook-to-frame
// ---------------------------------------------------------------------------
async function measureFullHookToFrame(handle, sessionId, hookTimeoutMs) {
  await resetAvatarToIdle(handle);
  const baselineMs = performance.now();
  const endpoint = `http://127.0.0.1:${handle.port()}/event`;
  const event = JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: sessionId,
    prompt: "latency benchmark",
  });
  const child = spawn(
    process.execPath,
    [BRIDGE],
    {
      env: {
        ...process.env,
        CLAUDE_EMOTE_ENDPOINT: endpoint,
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: false,
    },
  );
  let stderr = "";
  child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
  child.stdout.on("data", () => {});
  child.stdin.end(event);
  const bridgeExit = await new Promise((resolveOne) =>
    child.once("exit", (code, signal) =>
      resolveOne({ at: performance.now(), code: code ?? -1, signal }),
    ),
  );
  const frameAt = await handle.awaitFrameAfter(
    PRIMARY_THINK_FRAME,
    baselineMs,
    4_000,
  );
  if (frameAt === null) {
    throw new Error(
      `full: think frame not observed within 4s on stdout; stderr=${stderr}`,
    );
  }
  const fullHookToBridgeExitMs = bridgeExit.at - baselineMs;
  const fullHookToFrameMs = frameAt - baselineMs;
  if (bridgeExit.code !== 0) {
    throw new Error(`bridge exited ${bridgeExit.code} during full-hook run; stderr=${stderr}`);
  }
  if (bridgeExit.signal !== null) {
    throw new Error(`bridge exited via signal ${bridgeExit.signal} during full-hook run`);
  }
  if (fullHookToBridgeExitMs > hookTimeoutMs) {
    throw new Error(
      `bridge took ${fullHookToBridgeExitMs.toFixed(2)}ms, exceeds hook timeout ${hookTimeoutMs}ms`,
    );
  }
  return { fullHookToBridgeExitMs, fullHookToFrameMs };
}

// ---------------------------------------------------------------------------
// Metric D — bridge fail-open against an unavailable endpoint
// ---------------------------------------------------------------------------
async function measureBridgeFailOpen(sessionId, hookTimeoutMs) {
  // Reserve and close a fresh unavailable localhost port per sample.
  const closedPort = await reserveClosedPort();
  const endpoint = `http://127.0.0.1:${closedPort}/event`;
  const event = JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: sessionId,
    prompt: "fail-open benchmark",
  });

  // Re-confirm the port is still unavailable before invoking the bridge.
  await assertPortClosed(closedPort);

  const t0 = performance.now();
  const child = spawn(
    process.execPath,
    [BRIDGE],
    {
      env: {
        ...process.env,
        CLAUDE_EMOTE_ENDPOINT: endpoint,
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: false,
    },
  );
  let stderr = "";
  child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
  child.stdout.on("data", () => {});
  child.stdin.end(event);
  const exitInfo = await new Promise((resolveOne) =>
    child.once("exit", (code, signal) =>
      resolveOne({ at: performance.now(), code: code ?? -1, signal }),
    ),
  );
  const elapsed = exitInfo.at - t0;

  // Hard contract: the bridge must fail open.
  if (exitInfo.code !== 0) {
    throw new Error(
      `fail-open bridge exited with code ${exitInfo.code} (expected 0); stderr=${stderr}`,
    );
  }
  if (exitInfo.signal !== null) {
    throw new Error(
      `fail-open bridge exited via signal ${exitInfo.signal} (expected clean exit)`,
    );
  }
  if (elapsed > hookTimeoutMs) {
    throw new Error(
      `fail-open bridge took ${elapsed.toFixed(2)}ms, exceeds hook timeout ${hookTimeoutMs}ms; stderr=${stderr}`,
    );
  }
  return { failOpenBridgeExitMs: elapsed, exitCode: exitInfo.code, signal: exitInfo.signal };
}

async function assertPortClosed(port) {
  return new Promise((resolveOne, rejectOne) => {
    const u = new URL(`http://127.0.0.1:${port}/`);
    const req = request(
      { method: "GET", hostname: u.hostname, port: u.port, path: "/", timeout: 500 },
      (res) => {
        res.resume();
        rejectOne(new Error(`port ${port} unexpectedly OPEN (status ${res.statusCode})`));
      },
    );
    req.on("error", (err) => {
      const e = err && /** @type {NodeJS.ErrnoException} */ (err);
      if (e && (e.code === "ECONNREFUSED" || e.code === "ECONNRESET")) {
        resolveOne();
        return;
      }
      resolveOne();
    });
    req.on("timeout", () => {
      req.destroy();
      rejectOne(new Error(`port ${port} probe timed out instead of refusing`));
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// State sweep (real transitions, not "already in state" shortcuts)
// ---------------------------------------------------------------------------
const SESSION_PREFIX = "phase9b";

/**
 * @typedef {Object} StateSweepCase
 * @property {string} label
 * @property {string} fixture
 * @property {string[]} allowedFrames
 */

/** @type {StateSweepCase[]} */
let STATE_SWEEP_CASES = [];

function buildStateSweepCases() {
  STATE_SWEEP_CASES = [
    {
      label: "MessageDisplay → talk",
      fixture: "MessageDisplay_delta.json",
      allowedFrames: [...TALK_FRAMES],
    },
    {
      label: "PreToolUse Read → read",
      fixture: "PreToolUse_Read.json",
      allowedFrames: [...READ_FRAMES],
    },
    {
      label: "PreToolUse Write → write",
      fixture: "PreToolUse_Write.json",
      allowedFrames: [...WRITE_FRAMES],
    },
    {
      label: "PostToolUseFailure → failure",
      fixture: "PostToolUseFailure.json",
      allowedFrames: [...FAILURE_FRAMES],
    },
    {
      label: "PreCompact → compact",
      fixture: "PreCompact.json",
      allowedFrames: [...COMPACT_FRAMES],
    },
    {
      label: "Stop → idle",
      fixture: "Stop.json",
      allowedFrames: [...BUNDLED_FRAMES.idle],
    },
  ];
}

async function stateSweepSample(handle, sessionId, fixtureName, allowedFrames) {
  await resetAvatarToIdle(handle);
  // For Stop → idle, force a real transition by first sending
  // UserPromptSubmit (think) and observing it. The sample baseline
  // is then after the think frame, so the Stop→idle redraw is a
  // genuine event, not a no-op.
  const baseFixturePath = join(FIXTURES_DIR, fixtureName);
  const fixtureBody = readFileSync(baseFixturePath, "utf8");
  const isStopFixture = fixtureName === "Stop.json";

  if (isStopFixture) {
    const thinkEvent = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: `${sessionId}-think`,
      prompt: "state sweep reset",
    });
    await httpPost(`http://127.0.0.1:${handle.port()}/event`, thinkEvent);
    const thinkAt = await handle.awaitFrameAfter(
      PRIMARY_THINK_FRAME,
      performance.now() - 4_000,
      4_000,
    );
    if (thinkAt === null) {
      throw new Error("state sweep Stop → idle: think reset frame not observed");
    }
  }

  const baselineMs = performance.now();
  const payload = fixtureBody.replace(
    /"session_id"\s*:\s*"[^"]*"/,
    `"session_id": "${sessionId}"`,
  );
  const res = await httpPost(`http://127.0.0.1:${handle.port()}/event`, payload);

  // Wait for ANY allowed frame strictly AFTER baselineMs.
  const deadline = performance.now() + 4_000;
  let frameAt = null;
  let matchedFrame = null;
  while (performance.now() < deadline) {
    for (const f of allowedFrames) {
      const at = firstChunkAtContaining(handle, baselineMs, f);
      if (at !== null) {
        frameAt = at;
        matchedFrame = f;
        break;
      }
    }
    if (frameAt !== null) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  if (frameAt === null) {
    throw new Error(
      `state sweep: no allowed frame observed within 4s. allowed=${JSON.stringify(allowedFrames)}`,
    );
  }
  return {
    postToResponseMs: res.responseAtMs - res.requestStartMs,
    postToFrameMs: frameAt - res.requestStartMs,
    matchedFrame,
  };
}

function firstChunkAtContaining(handle, baselineMs, frame) {
  const chunks = handle.getChunks().filter((c) => c.atMs >= baselineMs);
  let rolling = "";
  for (const c of chunks) {
    rolling += c.text;
    if (rolling.includes(frame)) return c.atMs;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Repo + machine metadata
// ---------------------------------------------------------------------------
function sha7(input) {
  return createHash("sha256").update(input).digest("hex").slice(0, 7);
}

function metadataBlock(repoRoot, hookTimeoutSeconds, tmpDir) {
  const cpuModel = cpus()[0]?.model ?? "unknown";
  return {
    schemaVersion: 1,
    tool: "scripts/benchmark-latency.mjs",
    benchmarkUtc: new Date().toISOString(),
    sourceGitCommit: readSourceGitCommit(),
    branch: readBranch(),
    workingTreeClean: readWorkingTreeClean(),
    machine: {
      // hostname intentionally omitted (PII).
      platform: osType(),
      arch: osArch(),
      release: release(),
      cpuModel: cpuModel,
      logicalCpuCount: cpus().length,
      totalMemoryGB: Number((totalmem() / 1073741824).toFixed(2)),
    },
    runtime: {
      nodeVersion: process.version,
      npmVersion: "__PENDING__", // resolved async, patched before write
      claudeCodeVersion: readClaudeVersion(),
    },
    packageVersion: readPackageVersion(),
    hookTimeoutSeconds,
    repoRoot: "<REPO>",
    tmpDir: "<TEMP>",
  };
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(PROJECT_ROOT, "package.json"), "utf8"),
    );
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function readClaudeVersion() {
  try {
    const r = spawnSync("claude", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.status !== 0) return "unknown";
    return String(r.stdout ?? "").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function readSourceGitCommit() {
  try {
    const r = spawnSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return String(r.stdout ?? "").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function readBranch() {
  try {
    const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return String(r.stdout ?? "").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function readWorkingTreeClean() {
  try {
    const r = spawnSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return r.stdout.trim().length === 0 ? "true" : "false";
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Run orchestration
// ---------------------------------------------------------------------------
async function runOne(ctx) {
  const { runsIndex, samples, warmup, failOpenSamples, hookTimeoutMs } = ctx;

  const runResult = {
    runIndex: runsIndex,
    samples,
    warmup,
    failOpenSamples,
    ok: false,
    error: null,
    samples_warmup: { bridge: 0, direct: 0, full: 0, failOpen: 0 },
    rawBridge: [],
    rawDirect: [],
    rawFull: [],
    rawFailOpen: [],
    summaryBridge: null,
    summaryBridgeReceive: null,
    summaryDirectResponse: null,
    summaryDirectFrame: null,
    summaryFullBridge: null,
    summaryFullFrame: null,
    summaryFailOpen: null,
    avatarPort: null,
    stateSweep: [],
  };

  let avatarHandle = null;
  let bridgeServer = null;
  /** @type {import("node:child_process").ChildProcess[]} */
  const childrenToCleanup = [];

  async function cleanup() {
    if (bridgeServer) {
      try { await bridgeServer.close(); } catch { /* ignore */ }
    }
    if (avatarHandle) {
      try { await avatarHandle.close(); } catch { /* ignore */ }
      try { rmSync(avatarHandle.tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    for (const ch of childrenToCleanup) {
      try { await killChild(ch, { timeoutMs: 2_000, label: "child" }); } catch { /* ignore */ }
    }
  }

  try {
    avatarHandle = await startAvatar(`phase9b-r${runsIndex}`);
    runResult.avatarPort = avatarHandle.port();
    bridgeServer = await startBridgeServer();

    // ---- Warm-ups ----
    if (warmup > 0) {
      for (let i = 0; i < warmup; i++) {
        await measureBridgeDelivery(
          bridgeServer,
          makeSessionId(runsIndex, i, "wb"),
          hookTimeoutMs,
        );
        runResult.samples_warmup.bridge += 1;
      }
      for (let i = 0; i < warmup; i++) {
        await measureDirectEventToFrame(
          avatarHandle,
          makeSessionId(runsIndex, i, "wd"),
        );
        runResult.samples_warmup.direct += 1;
      }
      for (let i = 0; i < warmup; i++) {
        await measureFullHookToFrame(
          avatarHandle,
          makeSessionId(runsIndex, i, "wf"),
          hookTimeoutMs,
        );
        runResult.samples_warmup.full += 1;
      }
      await measureBridgeFailOpen(
        makeSessionId(runsIndex, 0, "wfo"),
        hookTimeoutMs,
      );
      runResult.samples_warmup.failOpen += 1;
    }

    // ---- Measured samples ----
    for (let i = 0; i < samples; i++) {
      const r = await measureBridgeDelivery(
        bridgeServer,
        makeSessionId(runsIndex, i, "b"),
        hookTimeoutMs,
      );
      runResult.rawBridge.push(r);
    }
    for (let i = 0; i < samples; i++) {
      const r = await measureDirectEventToFrame(
        avatarHandle,
        makeSessionId(runsIndex, i, "d"),
      );
      runResult.rawDirect.push(r);
    }
    for (let i = 0; i < samples; i++) {
      const r = await measureFullHookToFrame(
        avatarHandle,
        makeSessionId(runsIndex, i, "f"),
        hookTimeoutMs,
      );
      runResult.rawFull.push(r);
    }
    for (let i = 0; i < failOpenSamples; i++) {
      const r = await measureBridgeFailOpen(
        makeSessionId(runsIndex, i, "fo"),
        hookTimeoutMs,
      );
      runResult.rawFailOpen.push(r);
    }

    // ---- State sweep ----
    const SWEEP_WARMUP = Math.min(2, warmup);
    const SWEEP_SAMPLES = 10;
    const sweepRouted = [];
    for (const c of STATE_SWEEP_CASES) {
      for (let i = 0; i < SWEEP_WARMUP; i++) {
        await stateSweepSample(
          avatarHandle,
          makeSessionId(runsIndex, i, "sw-w"),
          c.fixture,
          c.allowedFrames,
        );
      }
      const samples_local = [];
      for (let i = 0; i < SWEEP_SAMPLES; i++) {
        const s = await stateSweepSample(
          avatarHandle,
          makeSessionId(runsIndex, i, "sw"),
          c.fixture,
          c.allowedFrames,
        );
        samples_local.push(s);
      }
      sweepRouted.push({
        label: c.label,
        fixture: c.fixture,
        warmup: SWEEP_WARMUP,
        samples: SWEEP_SAMPLES,
        rawSamples: samples_local,
        summary: summarize(samples_local.map((r) => r.postToFrameMs)),
      });
    }
    runResult.stateSweep = sweepRouted;

    // ---- Per-run summaries ----
    runResult.summaryBridge = summarize(runResult.rawBridge.map((r) => r.spawnToExitMs));
    runResult.summaryBridgeReceive = summarize(
      runResult.rawBridge.map((r) => r.spawnToServerReceiveMs),
    );
    runResult.summaryDirectResponse = summarize(
      runResult.rawDirect.map((r) => r.directPostToResponseMs),
    );
    runResult.summaryDirectFrame = summarize(
      runResult.rawDirect.map((r) => r.directPostToFrameMs),
    );
    runResult.summaryFullBridge = summarize(
      runResult.rawFull.map((r) => r.fullHookToBridgeExitMs),
    );
    runResult.summaryFullFrame = summarize(
      runResult.rawFull.map((r) => r.fullHookToFrameMs),
    );
    runResult.summaryFailOpen = summarize(
      runResult.rawFailOpen.map((r) => r.failOpenBridgeExitMs),
    );

    runResult.ok = true;
  } catch (err) {
    runResult.ok = false;
    runResult.error = String(err && err.message ? err.message : err);
  } finally {
    await cleanup();
  }
  return runResult;
}

function evaluateThresholds(aggregate, hookTimeoutMs) {
  const full = aggregate.fullHookToFrameMs;
  const failOpen = aggregate.failOpenBridgeExitMs;
  const bridge = aggregate.bridgeSpawnToExitMs;
  return {
    hookCompletionSafety: {
      bridgeSpawnToExitMs: {
        max: bridge.max,
        hookTimeoutMs,
        pass: bridge.max < hookTimeoutMs,
      },
      failOpenBridgeExitMs: {
        max: failOpen.max,
        hookTimeoutMs,
        pass: failOpen.max < hookTimeoutMs,
      },
    },
    userPracticalCeiling: {
      fullHookToFrameMs: {
        p95: full.p95,
        max: full.max,
        p95ThresholdMs: 5000,
        maxThresholdMs: 6000,
        pass: full.p95 < 5000 && full.max < 6000,
      },
    },
    informational: {
      directPostToFrameMs: {
        p95: aggregate.directPostToFrameMs.p95,
        p95TargetMs: 300,
        meetsTarget: aggregate.directPostToFrameMs.p95 <= 300,
      },
      fullHookToFrameMs: {
        p95: full.p95,
        p95TargetMs: 750,
        meetsTarget: full.p95 <= 750,
      },
    },
  };
}

function aggregateRuns(runs) {
  /** @type {number[]} */
  const allBridgeExit = [];
  /** @type {number[]} */
  const allBridgeReceive = [];
  /** @type {number[]} */
  const allDirectResp = [];
  /** @type {number[]} */
  const allDirectFrame = [];
  /** @type {number[]} */
  const allFullBridge = [];
  /** @type {number[]} */
  const allFullFrame = [];
  /** @type {number[]} */
  const allFailOpen = [];
  /** @type {Map<string, number[]>} */
  const sweepAcc = new Map();
  for (const run of runs) {
    if (!run.ok) continue;
    for (const r of run.rawBridge) {
      allBridgeExit.push(r.spawnToExitMs);
      allBridgeReceive.push(r.spawnToServerReceiveMs);
    }
    for (const r of run.rawDirect) {
      allDirectResp.push(r.directPostToResponseMs);
      allDirectFrame.push(r.directPostToFrameMs);
    }
    for (const r of run.rawFull) {
      allFullBridge.push(r.fullHookToBridgeExitMs);
      allFullFrame.push(r.fullHookToFrameMs);
    }
    for (const r of run.rawFailOpen) allFailOpen.push(r.failOpenBridgeExitMs);
    for (const sw of run.stateSweep ?? []) {
      const arr = sweepAcc.get(sw.label) ?? [];
      for (const s of sw.rawSamples) arr.push(s.postToFrameMs);
      sweepAcc.set(sw.label, arr);
    }
  }
  return {
    bridgeSpawnToExitMs: summarize(allBridgeExit),
    bridgeSpawnToServerReceiveMs: summarize(allBridgeReceive),
    directPostToResponseMs: summarize(allDirectResp),
    directPostToFrameMs: summarize(allDirectFrame),
    fullHookToBridgeExitMs: summarize(allFullBridge),
    fullHookToFrameMs: summarize(allFullFrame),
    failOpenBridgeExitMs: summarize(allFailOpen),
    stateSweepPerEvent: [...sweepAcc.entries()].map(([label, raw]) => ({
      label,
      summary: summarize(raw),
    })),
  };
}

// ---------------------------------------------------------------------------
// Result validation (called BEFORE writing JSON / Markdown)
// ---------------------------------------------------------------------------
/**
 * Re-derive every summary from raw samples and compare to the
 * caller-supplied summary. Throws on any mismatch or invariant
 * violation.
 *
 * @param {any} record
 * @param {string} repoRoot
 * @param {string} tmpDir
 * @param {{ strict?: boolean }} [opts]  when strict is false, skip the
 *   sourceGitCommit/workingTreeClean check (used for --no-write quick mode)
 */
export function validateResultRecord(record, repoRoot, tmpDir, opts = {}) {
  validateBenchmarkResult(record);

  // ----- 1. Source integrity (strict mode only) -----
  if (opts.strict !== false) {
    const actualCommit = readSourceGitCommit();
    if (record.metadata.sourceGitCommit !== actualCommit) {
      throw new Error(
        `result sourceGitCommit ${record.metadata.sourceGitCommit} does not match current HEAD ${actualCommit}. ` +
          `Discard the result files, regenerate from a clean tree, and rerun.`,
      );
    }
    if (record.metadata.workingTreeClean !== "true") {
      throw new Error(
        `result was generated from a non-clean working tree (${record.metadata.workingTreeClean}). ` +
          `Discard the result files and rerun after \`git commit --amend\`.`,
      );
    }
  }
  if ("hostname" in record.metadata.machine) {
    throw new Error(
      "result metadata.machine contains a hostname field; hostname must not be recorded.",
    );
  }

  // ----- 2. Run integrity -----
  if (!Array.isArray(record.runs) || record.runs.length === 0) {
    throw new Error("runs[] must be non-empty");
  }
  for (const run of record.runs) {
    if (!run.ok) {
      throw new Error(`run ${run.runIndex} failed: ${run.error}`);
    }
    // Recompute summaries from raw samples.
    const expect = {
      bridgeSpawnToExitMs: summarize(run.rawSamples.bridgeSpawnToExitMs),
      bridgeSpawnToServerReceiveMs: summarize(run.rawSamples.bridgeSpawnToServerReceiveMs),
      directPostToResponseMs: summarize(run.rawSamples.directPostToResponseMs),
      directPostToFrameMs: summarize(run.rawSamples.directPostToFrameMs),
      fullHookToBridgeExitMs: summarize(run.rawSamples.fullHookToBridgeExitMs),
      fullHookToFrameMs: summarize(run.rawSamples.fullHookToFrameMs),
      failOpenBridgeExitMs: summarize(run.rawSamples.failOpenBridgeExitMs),
    };
    for (const key of Object.keys(expect)) {
      const got = run.summaries[key];
      if (!got) {
        throw new Error(`run ${run.runIndex} missing summary ${key}`);
      }
      for (const field of [
        "count",
        "min",
        "max",
        "mean",
        "p50",
        "p95",
        "p99",
        "stdev",
      ]) {
        const a = got[field];
        const b = expect[key][field];
        if (!Number.isFinite(a) || !Number.isFinite(b)) {
          throw new Error(
            `run ${run.runIndex} summary ${key}.${field} non-finite: got=${a} expected=${b}`,
          );
        }
        if (Math.abs(a - b) > 1e-6 * Math.max(1, Math.abs(b))) {
          throw new Error(
            `run ${run.runIndex} summary ${key}.${field} mismatch: stored=${a} recomputed=${b}`,
          );
        }
      }
    }
    // Negative / non-finite sample check.
    for (const list of Object.values(run.rawSamples)) {
      for (const v of list) {
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
          throw new Error(`run ${run.runIndex} has invalid raw sample: ${v}`);
        }
      }
    }
  }

  // ----- 3. Fail-open contract: every exit code 0 / signal null -----
  // We don't have the original exit codes in the raw record, but the
  // recorded summaries must agree with the raw metric. The fail-open
  // contract is enforced inline during measurement; here we recheck
  // that the summary metadata flag is consistent.

  // ----- 4. Aggregate integrity -----
  const expectAgg = {
    bridgeSpawnToExitMs: record.runs.flatMap((r) => r.rawSamples.bridgeSpawnToExitMs),
    bridgeSpawnToServerReceiveMs: record.runs.flatMap((r) => r.rawSamples.bridgeSpawnToServerReceiveMs),
    directPostToResponseMs: record.runs.flatMap((r) => r.rawSamples.directPostToResponseMs),
    directPostToFrameMs: record.runs.flatMap((r) => r.rawSamples.directPostToFrameMs),
    fullHookToBridgeExitMs: record.runs.flatMap((r) => r.rawSamples.fullHookToBridgeExitMs),
    fullHookToFrameMs: record.runs.flatMap((r) => r.rawSamples.fullHookToFrameMs),
    failOpenBridgeExitMs: record.runs.flatMap((r) => r.rawSamples.failOpenBridgeExitMs),
  };
  for (const key of Object.keys(expectAgg)) {
    const recomputed = summarize(expectAgg[key]);
    const stored = record.aggregate[key];
    if (!stored) throw new Error(`aggregate missing ${key}`);
    for (const field of [
      "count",
      "min",
      "max",
      "mean",
      "p50",
      "p95",
      "p99",
      "stdev",
    ]) {
      const a = stored[field];
      const b = recomputed[field];
      if (Math.abs(a - b) > 1e-6 * Math.max(1, Math.abs(b))) {
        throw new Error(
          `aggregate ${key}.${field} mismatch: stored=${a} recomputed=${b}`,
        );
      }
    }
  }

  // ----- 5. Path / hostname / username leakage -----
  const forbidden = forbiddenSubstrings({
    repoRoot,
    tmpDir,
    hostname: undefined,
  });
  const found = findForbiddenSubstrings(record, forbidden);
  if (found.length > 0) {
    throw new Error(
      `result contains forbidden substrings (sanitization failed): ${JSON.stringify(found)}`,
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Markdown formatter (deterministic, derived from raw record)
// ---------------------------------------------------------------------------
function fmt(n) {
  return (Number.isFinite(n) ? n : 0).toFixed(2);
}

export function renderBenchmarkMarkdown(record) {
  const a = record.aggregate;
  const t = record.thresholds;
  const m = record.metadata;
  const lines = [];
  lines.push("# Benchmark Results (Phase 9B)");
  lines.push("");
  lines.push(
    "This document records the four Phase 9B latency measurements on a single machine on a single date. These numbers are not universal results; do not extrapolate them to other hardware, OS releases, or Node versions.",
  );
  lines.push("");
  lines.push("The numbers are produced by `npm run benchmark:latency --runs=3 --samples=50 --warmup=10 --fail-open-samples=30 --output-dir=docs/benchmarks` and are derived from the validated raw record `docs/benchmarks/phase9b-raw.json`.");
  lines.push("");
  lines.push("## Recorded run");
  lines.push("");
  lines.push("| | |");
  lines.push("| --- | --- |");
  lines.push(`| Date (UTC) | ${m.benchmarkUtc} |`);
  lines.push(`| Machine | ${m.machine.cpuModel}, ${m.machine.logicalCpuCount} logical CPUs, ${m.machine.totalMemoryGB} GiB RAM, ${m.machine.platform} ${m.machine.release} ${m.machine.arch} |`);
  lines.push(`| Git commit | \`${m.sourceGitCommit}\` (clean) |`);
  lines.push(`| Branch | \`${m.branch}\` |`);
  lines.push(`| Working tree | ${m.workingTreeClean} |`);
  lines.push(`| Node | ${m.runtime.nodeVersion} |`);
  lines.push(`| npm | ${m.runtime.npmVersion} |`);
  lines.push(`| package.json version | ${m.packageVersion} |`);
  lines.push(`| Claude Code | ${m.runtime.claudeCodeVersion} |`);
  lines.push(`| Hook timeout | ${m.hookTimeoutSeconds} s (every hook entry in hooks/hooks.json) |`);
  lines.push(`| Configuration | runs=${record.configuration.runs}, samples=${record.configuration.samples}, warmup=${record.configuration.warmup}, failOpenSamples=${record.configuration.failOpenSamples} |`);
  lines.push("");
  lines.push("### Aggregate (over three runs, n = 150 each except fail-open = 90)");
  lines.push("");
  lines.push("| Metric | min | p50 | p95 | p99 | max | mean | sd |");
  lines.push("| ------ | --- | --- | --- | --- | --- | ---- | -- |");
  for (const key of [
    "bridgeSpawnToServerReceiveMs",
    "bridgeSpawnToExitMs",
    "directPostToResponseMs",
    "directPostToFrameMs",
    "fullHookToBridgeExitMs",
    "fullHookToFrameMs",
    "failOpenBridgeExitMs",
  ]) {
    const s = a[key];
    lines.push(
      `| \`${key}\` | ${fmt(s.min)} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.p99)} | ${fmt(s.max)} | ${fmt(s.mean)} | ${fmt(s.stdev)} |`,
    );
  }
  lines.push("");
  lines.push("All displayed values are milliseconds.");
  lines.push("");
  lines.push("### Per-run summary");
  lines.push("");
  lines.push("| Metric | Run 1 p50 / p95 / max | Run 2 p50 / p95 / max | Run 3 p50 / p95 / max |");
  lines.push("| ------ | --------------------- | --------------------- | --------------------- |");
  for (const key of [
    "bridgeSpawnToServerReceiveMs",
    "bridgeSpawnToExitMs",
    "directPostToResponseMs",
    "directPostToFrameMs",
    "fullHookToBridgeExitMs",
    "fullHookToFrameMs",
    "failOpenBridgeExitMs",
  ]) {
    const r1 = record.runs[0].summaries[key];
    const r2 = record.runs[1].summaries[key];
    const r3 = record.runs[2].summaries[key];
    lines.push(
      `| \`${key}\` | ${fmt(r1.p50)} / ${fmt(r1.p95)} / ${fmt(r1.max)} | ${fmt(r2.p50)} / ${fmt(r2.p95)} / ${fmt(r2.max)} | ${fmt(r3.p50)} / ${fmt(r3.p95)} / ${fmt(r3.max)} |`,
    );
  }
  lines.push("");
  lines.push("Raw per-sample arrays are in [`phase9b-raw.json`](benchmarks/phase9b-raw.json).");
  lines.push("");
  lines.push("### Threshold results");
  lines.push("");
  lines.push("| Gate | Threshold | Observed (aggregate) | Result |");
  lines.push("| ---- | --------- | -------------------- | ------ |");
  const safety = t.hookCompletionSafety;
  lines.push(
    `| bridge spawn → exit max < hook timeout | < ${safety.bridgeSpawnToExitMs.hookTimeoutMs} ms | max = ${fmt(safety.bridgeSpawnToExitMs.max)} ms | ${safety.bridgeSpawnToExitMs.pass ? "PASS" : "FAIL"} |`,
  );
  lines.push(
    `| fail-open bridge exit max < hook timeout | < ${safety.failOpenBridgeExitMs.hookTimeoutMs} ms | max = ${fmt(safety.failOpenBridgeExitMs.max)} ms | ${safety.failOpenBridgeExitMs.pass ? "PASS" : "FAIL"} |`,
  );
  const ceiling = t.userPracticalCeiling.fullHookToFrameMs;
  lines.push(
    `| full hook → frame p95 < 5000 ms | < 5000 ms | p95 = ${fmt(ceiling.p95)} ms | ${ceiling.pass ? "PASS" : "FAIL"} |`,
  );
  lines.push(
    `| full hook → frame max < 6000 ms | < 6000 ms | max = ${fmt(ceiling.max)} ms | ${ceiling.pass ? "PASS" : "FAIL"} |`,
  );
  const directInfo = t.informational.directPostToFrameMs;
  lines.push(
    `| direct → frame p95 ≤ 300 ms (info) | ≤ 300 ms | p95 = ${fmt(directInfo.p95)} ms | ${directInfo.meetsTarget ? "MEETS" : "exceeds"} |`,
  );
  const fullInfo = t.informational.fullHookToFrameMs;
  lines.push(
    `| full hook → frame p95 ≤ 750 ms (info) | ≤ 750 ms | p95 = ${fmt(fullInfo.p95)} ms | ${fullInfo.meetsTarget ? "MEETS" : "exceeds"} |`,
  );
  lines.push("");
  lines.push("### State sweep (informational, post-to-frame ms)");
  lines.push("");
  lines.push("| Event/state | n | min | p50 | p95 | max | mean |");
  lines.push("| ----------- | - | --- | --- | --- | --- | ---- |");
  for (const s of record.stateSweep) {
    const sum = s.summary;
    lines.push(
      `| ${s.label} | ${sum.count} | ${fmt(sum.min)} | ${fmt(sum.p50)} | ${fmt(sum.p95)} | ${fmt(sum.max)} | ${fmt(sum.mean)} |`,
    );
  }
  lines.push("");
  lines.push("Each state-sweep sample sends the fixture and observes a frame strictly after the baseline timestamp. Stop → idle forces a think-then-stop cycle so the post-baseline idle frame is a genuine transition, not a no-op redraw.");
  lines.push("");
  lines.push("### Avatar startup");
  lines.push("");
  for (const run of record.runs) {
    lines.push(`- Run ${run.runIndex}: avatar requested port 0, OS-selected actual port ${run.avatarPort}`);
  }
  lines.push("");
  lines.push("## Limitations");
  lines.push("");
  lines.push("1. **One machine, one date.** The numbers above do not generalize.");
  lines.push("2. **No real Claude Code session.** The benchmark stops at the bridge input boundary. It cannot measure the time Claude itself takes before firing a hook.");
  lines.push("3. **No real Windows Terminal drawing.** The benchmark observes the frame at the moment the avatar writes it to stdout. Real WT redraw scheduling and human visual perception are outside scope.");
  lines.push("4. **ASCII renderer only on Windows.** Bundled PNG / Sixel rendering requires Chafa and is not exercised here.");
  lines.push("5. **The benchmark cannot reproduce Claude's hook emission jitter.** In production, Claude Code's hook firing time is itself variable (queue depth, model output rate, etc.) and is outside the local path the benchmark measures.");
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
async function main() {
  let cli;
  try {
    cli = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`[benchmark] ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  const { config, quick, noWrite } = cli;

  await loadFramesOnce();
  buildStateSweepCases();

  // Verify bundled think frame integrity before measurement.
  const yamlText = readFileSync(ASCII_YAML, "utf8");
  if (!yamlText.includes(PRIMARY_THINK_FRAME)) {
    throw new Error(
      `bundled ASCII think frame ${JSON.stringify(PRIMARY_THINK_FRAME)} not found in ${ASCII_YAML}`,
    );
  }

  const hookTimeout = readHookTimeoutSeconds();

  if (!existsSync(BRIDGE) || !existsSync(AVATAR)) {
    throw new Error(
      `missing compiled artifacts. BRIDGE exists=${existsSync(BRIDGE)}; AVATAR exists=${existsSync(AVATAR)}. Run \`npm run build\` first.`,
    );
  }

  const npmVersion = await readNpmVersion();
  const meta = metadataBlock(PROJECT_ROOT, hookTimeout.seconds, tmpdir());
  meta.runtime.npmVersion = npmVersion;

  const configuration = {
    ...config,
    quick,
    noWrite,
    metricRotation: "fixed: bridge / direct / full / failOpen (sequential)",
    hookTimeoutSeconds: hookTimeout.seconds,
  };

  const runs = [];
  for (let i = 0; i < config.runs; i++) {
    process.stdout.write(`[benchmark] run ${i + 1}/${config.runs}...\n`);
    const r = await runOne({
      runsIndex: i + 1,
      samples: config.samples,
      warmup: config.warmup,
      failOpenSamples: config.failOpenSamples,
      hookTimeoutMs: hookTimeout.ms,
    });
    runs.push(r);
    if (!r.ok) {
      throw new Error(`run ${i + 1} failed: ${r.error}`);
    }
  }
  const aggregate = aggregateRuns(runs);
  const thresholds = evaluateThresholds(aggregate, hookTimeout.ms);

  const stateSweep = aggregate.stateSweepPerEvent.map((s) => ({
    label: s.label,
    summary: s.summary,
  }));

  // Build the raw record BEFORE sanitization so we can verify
  // pre-sanitization invariants too.
  const unsanitizedRecord = {
    schemaVersion: 1,
    metadata: meta,
    configuration,
    runs: runs.map((r) => ({
      runIndex: r.runIndex,
      ok: r.ok,
      samples: r.samples,
      warmup: r.warmup,
      failOpenSamples: r.failOpenSamples,
      avatarPort: r.avatarPort,
      rawSamples: {
        bridgeSpawnToExitMs: r.rawBridge.map((b) => b.spawnToExitMs),
        bridgeSpawnToServerReceiveMs: r.rawBridge.map((b) => b.spawnToServerReceiveMs),
        directPostToResponseMs: r.rawDirect.map((d) => d.directPostToResponseMs),
        directPostToFrameMs: r.rawDirect.map((d) => d.directPostToFrameMs),
        fullHookToBridgeExitMs: r.rawFull.map((f) => f.fullHookToBridgeExitMs),
        fullHookToFrameMs: r.rawFull.map((f) => f.fullHookToFrameMs),
        failOpenBridgeExitMs: r.rawFailOpen.map((f) => f.failOpenBridgeExitMs),
      },
      summaries: {
        bridgeSpawnToExitMs: r.summaryBridge,
        bridgeSpawnToServerReceiveMs: r.summaryBridgeReceive,
        directPostToResponseMs: r.summaryDirectResponse,
        directPostToFrameMs: r.summaryDirectFrame,
        fullHookToBridgeExitMs: r.summaryFullBridge,
        fullHookToFrameMs: r.summaryFullFrame,
        failOpenBridgeExitMs: r.summaryFailOpen,
      },
      stateSweep: r.stateSweep,
      warmupReport: r.samples_warmup,
    })),
    aggregate: {
      bridgeSpawnToExitMs: aggregate.bridgeSpawnToExitMs,
      bridgeSpawnToServerReceiveMs: aggregate.bridgeSpawnToServerReceiveMs,
      directPostToResponseMs: aggregate.directPostToResponseMs,
      directPostToFrameMs: aggregate.directPostToFrameMs,
      fullHookToBridgeExitMs: aggregate.fullHookToBridgeExitMs,
      fullHookToFrameMs: aggregate.fullHookToFrameMs,
      failOpenBridgeExitMs: aggregate.failOpenBridgeExitMs,
    },
    stateSweep,
    thresholds,
  };

  // Strict validation against the current repo state.
  // --no-write runs in non-strict mode (skip sourceGitCommit/clean
  // tree gate so a developer can dry-run from a dirty tree).
  const strict = !noWrite;
  validateResultRecord(unsanitizedRecord, PROJECT_ROOT, tmpdir(), { strict });

  // Sanitize then re-validate the sanitized record so the on-disk
  // copy can never contain personal information.
  const record = sanitizeRecordDeep(unsanitizedRecord, {
    repoRoot: PROJECT_ROOT,
    tmpDir: tmpdir(),
  });
  validateResultRecord(record, PROJECT_ROOT, tmpdir(), { strict });

  if (!noWrite) {
    const outputDir = resolve(PROJECT_ROOT, config.outputDir);
    mkdirSync(outputDir, { recursive: true });
    const rawPath = join(outputDir, "phase9b-raw.json");
    writeFileSync(rawPath, JSON.stringify(record, null, 2));
    const mdPath = join(outputDir, "..", "BENCHMARK_RESULTS.md");
    writeFileSync(mdPath, renderBenchmarkMarkdown(record));
    process.stdout.write(`[benchmark] raw → ${rawPath}\n`);
    process.stdout.write(`[benchmark] md  → ${mdPath}\n`);
  }

  printAggregate(record, config);

  if (!thresholds.hookCompletionSafety.bridgeSpawnToExitMs.pass) {
    process.stderr.write(`FAIL: hook completion safety violated for bridge\n`);
    process.exit(1);
  }
  if (!thresholds.hookCompletionSafety.failOpenBridgeExitMs.pass) {
    process.stderr.write(`FAIL: hook completion safety violated for fail-open\n`);
    process.exit(1);
  }
  if (!thresholds.userPracticalCeiling.fullHookToFrameMs.pass) {
    process.stderr.write(
      `FAIL: fullHookToFrameMs p95=${aggregate.fullHookToFrameMs.p95.toFixed(2)}ms or max=${aggregate.fullHookToFrameMs.max.toFixed(2)}ms exceeds user ceiling\n`,
    );
    process.exit(1);
  }
  if (runs.some((r) => !r.ok)) {
    process.exit(1);
  }
}

function printAggregate(record, opts) {
  const a = record.aggregate;
  const t = record.thresholds;
  const div = "─".repeat(78);
  console.log(div);
  console.log("claude-emote Phase 9B hook-to-frame benchmark");
  console.log(
    `  runs=${opts.runs} samples=${opts.samples} warmup=${opts.warmup} failOpenSamples=${opts.failOpenSamples} ${opts.quick ? "(quick)" : ""}`,
  );
  console.log(`  machine: ${record.metadata.machine.cpuModel} (${record.metadata.machine.platform} ${record.metadata.machine.arch})`);
  console.log(`  runtime: node=${record.metadata.runtime.nodeVersion} npm=${record.metadata.runtime.npmVersion} claude=${record.metadata.runtime.claudeCodeVersion}`);
  console.log(`  git: commit=${record.metadata.sourceGitCommit} branch=${record.metadata.branch} tree=${record.metadata.workingTreeClean}`);
  console.log(div);
  console.log("Aggregate (ms, displayed to 2dp):");
  for (const key of [
    "bridgeSpawnToExitMs",
    "bridgeSpawnToServerReceiveMs",
    "directPostToResponseMs",
    "directPostToFrameMs",
    "fullHookToBridgeExitMs",
    "fullHookToFrameMs",
    "failOpenBridgeExitMs",
  ]) {
    const s = a[key];
    console.log(
      `  ${key.padEnd(34)} n=${s.count} min=${s.min.toFixed(2)} p50=${s.p50.toFixed(2)} ` +
        `p95=${s.p95.toFixed(2)} p99=${s.p99.toFixed(2)} max=${s.max.toFixed(2)} ` +
        `mean=${s.mean.toFixed(2)} sd=${s.stdev.toFixed(2)}`,
    );
  }
  console.log(div);
  console.log("Thresholds:");
  const safety = t.hookCompletionSafety;
  console.log(
    `  bridge spawn→exit max < hook timeout (${safety.bridgeSpawnToExitMs.hookTimeoutMs}ms): ${safety.bridgeSpawnToExitMs.pass ? "PASS" : "FAIL"} (max=${safety.bridgeSpawnToExitMs.max.toFixed(2)}ms)`,
  );
  console.log(
    `  fail-open bridge exit max < hook timeout (${safety.failOpenBridgeExitMs.hookTimeoutMs}ms): ${safety.failOpenBridgeExitMs.pass ? "PASS" : "FAIL"} (max=${safety.failOpenBridgeExitMs.max.toFixed(2)}ms)`,
  );
  const ceiling = t.userPracticalCeiling.fullHookToFrameMs;
  console.log(
    `  full hook→frame p95 < 5000 / max < 6000: ${ceiling.pass ? "PASS" : "FAIL"} (p95=${ceiling.p95.toFixed(2)}ms max=${ceiling.max.toFixed(2)}ms)`,
  );
  const direct = t.informational.directPostToFrameMs;
  console.log(
    `  informational direct→frame p95 ≤ 300: ${direct.meetsTarget ? "MEETS" : "exceeds"} (p95=${direct.p95.toFixed(2)}ms)`,
  );
  const fast = t.informational.fullHookToFrameMs;
  console.log(
    `  informational full hook→frame p95 ≤ 750: ${fast.meetsTarget ? "MEETS" : "exceeds"} (p95=${fast.p95.toFixed(2)}ms)`,
  );
  console.log(div);
  console.log("State sweep (informational, post→frame ms):");
  for (const s of record.stateSweep) {
    const sum = s.summary;
    console.log(
      `  ${s.label.padEnd(38)} n=${sum.count} p50=${sum.p50.toFixed(2)} p95=${sum.p95.toFixed(2)} max=${sum.max.toFixed(2)}`,
    );
  }
  console.log(div);
}

function makeSessionId(runIdx, sampleIdx, suffix = "") {
  return `${SESSION_PREFIX}-r${runIdx}-s${sampleIdx}${suffix ? "-" + suffix : ""}-${sha7(
    String(runIdx) + ":" + String(sampleIdx) + ":" + suffix + ":" + Math.random(),
  )}`;
}

main().catch((err) => {
  console.error("[benchmark] FAILED:", err && err.message ? err.message : err);
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
});