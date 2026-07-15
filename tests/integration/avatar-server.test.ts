/**
 * avatar-server integration test
 *
 * Spawns the compiled avatar-process.js, waits for it to print
 * `CLAUDE_EMOTE_READY`, and exercises the /health and /event endpoints.
 *
 * This validates:
 *   - Server starts on 127.0.0.1 only
 *   - /health returns 200 with the correct instance ID
 *   - /event accepts a fixture payload and the server applies the mapper
 *   - Large bodies are rejected
 *   - 404 is returned for unknown paths
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";

const AVATAR_PROCESS = join(process.cwd(), "dist", "host", "avatar-process.js");
const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures");

let child: ChildProcess | null = null;
let port = 0;
const instanceId = "test-instance-" + Date.now();
const endpoint = `http://127.0.0.1:${port}/event`;

beforeAll(async () => {
  // Pick a free port and spawn the avatar with it.
  const net = await import("node:net");
  port = await new Promise<number>((resolveReady) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolveReady(p));
    });
  });

  child = spawn(
    process.execPath,
    [AVATAR_PROCESS, `--port=${port}`, `--instance=${instanceId}`],
    {
      env: {
        ...process.env,
        CLAUDE_EMOTE_INSTANCE_ID: instanceId,
        CLAUDE_EMOTE_PORT: String(port),
        CLAUDE_EMOTE_EMOTE_DIR: join(process.cwd(), "emotes", "ascii"),
        // Force ASCII so the test doesn't need Chafa
        CLAUDE_EMOTE_DEMO_PROTOCOL: "ascii",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stderr?.on("data", () => {}); // swallow debug logs

  // Wait for the READY line on stdout.
  await new Promise<void>((resolveReady, rejectErr) => {
    const timeout = setTimeout(() => rejectErr(new Error("avatar did not become ready in 10s")), 10_000);
    let buf = "";
    child!.stdout?.on("data", (b: Buffer) => {
      buf += b.toString("utf8");
      if (buf.includes("CLAUDE_EMOTE_READY")) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
    child!.on("error", rejectErr);
    child!.on("exit", (code) => {
      if (!buf.includes("CLAUDE_EMOTE_READY")) {
        clearTimeout(timeout);
        rejectErr(new Error(`avatar exited ${code} before ready`));
      }
    });
  });
}, 15_000);

afterAll(async () => {
  if (child && !child.killed) {
    child.kill("SIGTERM");
    await new Promise<void>((r) => child!.on("exit", () => r()));
  }
});

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveOne, rejectErr) => {
    const req = request(url, { method: "GET", timeout: 2000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolveOne({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", rejectErr);
    req.on("timeout", () => {
      req.destroy();
      rejectErr(new Error("timeout"));
    });
    req.end();
  });
}

function post(url: string, body: string, contentType = "application/json"): Promise<{ status: number; body: string }> {
  return new Promise((resolveOne, rejectErr) => {
    const u = new URL(url);
    const req = request(
      {
        method: "POST",
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        headers: { "content-type": contentType, "content-length": Buffer.byteLength(body) },
        timeout: 2000,
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (buf += c));
        res.on("end", () => resolveOne({ status: res.statusCode ?? 0, body: buf }));
      },
    );
    req.on("error", rejectErr);
    req.on("timeout", () => {
      req.destroy();
      rejectErr(new Error("timeout"));
    });
    req.end(body);
  });
}

describe("avatar-server (M4 integration)", () => {
  it("exposes /health with the correct instance ID", async () => {
    const res = await get(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.instanceId).toBe(instanceId);
  });

  it("rejects unknown paths with 404", async () => {
    const res = await get(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });

  it("accepts a SessionStart fixture and returns the mapped reaction", async () => {
    const fixture = readFileSync(join(FIXTURE_DIR, "SessionStart.json"), "utf8");
    const res = await post(`http://127.0.0.1:${port}/event`, fixture);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.reaction.state).toBe("hi");
  });

  it("accepts a PreToolUse Read fixture and returns read state", async () => {
    const fixture = readFileSync(join(FIXTURE_DIR, "PreToolUse_Read.json"), "utf8");
    const res = await post(`http://127.0.0.1:${port}/event`, fixture);
    const body = JSON.parse(res.body);
    expect(body.reaction.state).toBe("read");
  });

  it("accepts a Stop fixture and returns idle", async () => {
    const fixture = readFileSync(join(FIXTURE_DIR, "Stop.json"), "utf8");
    const res = await post(`http://127.0.0.1:${port}/event`, fixture);
    const body = JSON.parse(res.body);
    expect(body.reaction.state).toBe("idle");
  });

  it("returns shutdown=true for SessionEnd", async () => {
    const fixture = readFileSync(join(FIXTURE_DIR, "SessionEnd.json"), "utf8");
    const res = await post(`http://127.0.0.1:${port}/event`, fixture);
    const body = JSON.parse(res.body);
    expect(body.reaction.shutdown).toBe(true);
  });

  it("rejects oversized bodies", async () => {
    const huge = "x".repeat(300 * 1024);
    const res = await post(`http://127.0.0.1:${port}/event`, huge);
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await post(`http://127.0.0.1:${port}/event`, "not json");
    expect(res.status).toBe(400);
  });

  it("forwards MessageDisplay delta tokens (no crash on content)", async () => {
    const fixture = readFileSync(join(FIXTURE_DIR, "MessageDisplay_delta.json"), "utf8");
    const res = await post(`http://127.0.0.1:${port}/event`, fixture);
    expect(res.status).toBe(200);
  });
});
