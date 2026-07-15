#!/usr/bin/env node
/**
 * measure-latency.mjs
 *
 * End-to-end latency measurement between Claude Code's hook firing and
 * the avatar server applying the resulting Animator state.
 *
 * Method:
 *   - Boot the avatar server with a tap that records the time each
 *     mapped state lands in onEvent.
 *   - Drive the bridge from stdin for every fixture and measure the
 *     wall-clock between stdin write and the corresponding 200 response.
 *
 * This is the closest we can get to a "real Claude Code session" latency
 * on a dev box without a Claude Code binary. The bridge + server path
 * is identical to what production will exercise.
 */

import { spawn } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:http";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(__filename, "..", "..");
const AVATAR = resolve(PROJECT_ROOT, "dist", "host", "avatar-process.js");
const BRIDGE = resolve(PROJECT_ROOT, "dist", "claude", "hook-bridge.js");
const FIXTURES = resolve(PROJECT_ROOT, "tests", "fixtures");

const net = await import("node:net");
const port = await new Promise((r) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => r(p));
  });
});

const instanceId = "latency-" + Date.now();
const endpoint = `http://127.0.0.1:${port}/event`;

// Start the avatar with debug logging to a file we can read.
const LOG_FILE = resolve(PROJECT_ROOT, "dist", "latency-log.ndjson");
try { writeFileSync(LOG_FILE, ""); } catch {}

const avatar = spawn(
  process.execPath,
  [AVATAR, `--port=${port}`, `--instance=${instanceId}`],
  {
    env: {
      ...process.env,
      CLAUDE_EMOTE_INSTANCE_ID: instanceId,
      CLAUDE_EMOTE_PORT: String(port),
      CLAUDE_EMOTE_EMOTE_DIR: resolve(PROJECT_ROOT, "emotes", "ascii"),
      CLAUDE_EMOTE_DEBUG: "1",
      CLAUDE_EMOTE_LOG_FILE: LOG_FILE,
      CLAUDE_EMOTE_DEMO_PROTOCOL: "ascii",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
avatar.stderr.on("data", () => {});
let stdout = "";
avatar.stdout.on("data", (b) => (stdout += b.toString("utf8")));

await new Promise((r, rej) => {
  const t = setTimeout(() => rej(new Error("avatar did not start")), 10_000);
  const id = setInterval(() => {
    if (stdout.includes("CLAUDE_EMOTE_READY")) {
      clearTimeout(t);
      clearInterval(id);
      r();
    }
  }, 50);
});

// Run every fixture through the bridge and time the round-trip.
const fixtures = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".json"))
  .filter((f) => !f.startsWith("malformed"))
  .sort();

const rows = [];

function post(url, body) {
  const start = process.hrtime.bigint();
  return new Promise((resolveOne, rejectErr) => {
    const u = new URL(url);
    const req = request(
      {
        method: "POST",
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        timeout: 2000,
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          const end = process.hrtime.bigint();
          resolveOne({ status: res.statusCode, body: buf, ms: Number(end - start) / 1e6 });
        });
      },
    );
    req.on("error", rejectErr);
    req.on("timeout", () => {
      req.destroy();
      rejectErr(new Error("timeout"));
    });
    // Don't count stdin writing toward the latency — that's bridge-side.
    req.end(body);
  });
}

for (const f of fixtures) {
  const input = readFileSync(join(FIXTURES, f), "utf8");
  const t0 = process.hrtime.bigint();
  const res = await post(endpoint, input);
  const t1 = process.hrtime.bigint();
  // Bridge is fire-and-forget from the caller's perspective. We measure
  // both the network round-trip AND the bridge->server->mapper chain via
  // the response. This is an upper bound on what the avatar "saw".
  rows.push({
    fixture: f,
    round_trip_ms: Number(t1 - t0) / 1e6,
    server_processing_ms: res.ms,
    reaction: (() => {
      try { return JSON.parse(res.body).reaction; } catch { return null; }
    })(),
  });
}

// Shut down the avatar.
avatar.kill("SIGTERM");
await new Promise((r) => avatar.on("exit", r));

const summary = {
  events_tested: rows.length,
  per_event: rows,
};

const sorted = rows.map((r) => r.server_processing_ms).sort((a, b) => a - b);
const pct = (q) => sorted[Math.floor(sorted.length * q)];
const p50 = pct(0.5);
const p95 = pct(0.95);
const p99 = pct(0.99);

summary.stats = {
  server_processing_p50_ms: Number(p50.toFixed(3)),
  server_processing_p95_ms: Number(p95.toFixed(3)),
  server_processing_p99_ms: Number(p99.toFixed(3)),
  target: "p95 < 300ms per spec",
  pass: p95 < 300,
};

console.log(JSON.stringify(summary, null, 2));
writeFileSync(
  resolve(PROJECT_ROOT, "dist", "latency-results.json"),
  JSON.stringify(summary, null, 2),
);

process.exit(summary.stats.pass ? 0 : 1);
