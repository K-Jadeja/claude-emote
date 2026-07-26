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
import { readFileSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import { tmpdir } from "node:os";

const AVATAR_PROCESS = join(process.cwd(), "dist", "host", "avatar-process.js");
const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures");

let child: ChildProcess | null = null;
let port = 0;
let harnessDir: string | null = null;
const instanceId = "test-instance-" + Date.now();
const endpoint = `http://127.0.0.1:${port}/event`;
const capabilityToken = "avatar_server_test_capability_1234567890";
const authorization = `Bearer ${capabilityToken}`;

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

  // Phase 6: the avatar process validates that the chosen emote
  // directory is compatible with the resolved renderer. On Windows
  // the default `unknown` terminal maps to `sixel`, which needs
  // Chafa and PNG frames. This test wants ASCII. We use an isolated
  // cwd with an ASCII-forcing layered config so the terminal
  // resolution lands on ASCII and the bundled ASCII assets are
  // picked automatically.
  harnessDir = mkdtempSync(join(tmpdir(), "claude-emote-avatar-server-"));
  const configDir = join(harnessDir, ".claude-emote", "extensions", "claude-emote");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ terminals: [{ match: "unknown", render: "ascii" }] }),
  );

  // Strip renderer-affecting env vars so terminal detection falls
  // through to the layered config.
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.CLAUDE_EMOTE_CAPABILITY_TOKEN = capabilityToken;
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
    "CLAUDE_EMOTE_EMOTE_DIR",
    "CLAUDE_EMOTE_PARENT_PID",
    "CLAUDE_EMOTE_LOG_FILE",
    "CLAUDE_EMOTE_DEBUG",
    "CLAUDE_EMOTE_DEMO_PROTOCOL",
  ]) {
    delete env[k];
  }

  child = spawn(
    process.execPath,
    [AVATAR_PROCESS, `--port=${port}`, `--instance=${instanceId}`, `--parentPid=${process.pid}`],
    {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: harnessDir,
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
  if (harnessDir) {
    rmSync(harnessDir, { recursive: true, force: true });
    harnessDir = null;
  }
});

function get(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: import("node:http").IncomingHttpHeaders }> {
  return new Promise((resolveOne, rejectErr) => {
    const req = request(url, { method: "GET", headers, timeout: 2000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () =>
        resolveOne({
          status: res.statusCode ?? 0,
          body,
          headers: res.headers,
        }),
      );
    });
    req.on("error", rejectErr);
    req.on("timeout", () => {
      req.destroy();
      rejectErr(new Error("timeout"));
    });
    req.end();
  });
}

function readInitialSseEvent(url: string): Promise<{
  event: string;
  data: unknown;
  headers: import("node:http").IncomingHttpHeaders;
}> {
  return new Promise((resolveOne, rejectErr) => {
    let settled = false;
    const req = request(
      url,
      {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          origin: "http://127.0.0.1:61234",
          authorization,
        },
        timeout: 2_000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          const blocks = body.split("\n\n");
          const block = blocks.find((candidate) =>
            candidate.includes("event: snapshot"),
          );
          if (!block || settled) return;
          const event = block
            .split("\n")
            .find((line) => line.startsWith("event: "))
            ?.slice("event: ".length);
          const data = block
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice("data: ".length);
          if (!event || !data) return;
          settled = true;
          resolveOne({ event, data: JSON.parse(data), headers: res.headers });
          req.destroy();
        });
      },
    );
    req.on("error", (error) => {
      if (!settled) rejectErr(error);
    });
    req.on("timeout", () => {
      if (settled) return;
      req.destroy();
      rejectErr(new Error("SSE snapshot timeout"));
    });
    req.end();
  });
}

function post(
  url: string,
  body: string,
  contentType = "application/json",
  headers: Record<string, string> = { authorization },
): Promise<{ status: number; body: string }> {
  return new Promise((resolveOne, rejectErr) => {
    const u = new URL(url);
    const req = request(
      {
        method: "POST",
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        headers: {
          "content-type": contentType,
          "content-length": Buffer.byteLength(body),
          ...headers,
        },
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
    expect(body.capabilityRequired).toBe(true);
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

  it("rejects hook and state requests without the session capability", async () => {
    const fixture = readFileSync(join(FIXTURE_DIR, "SessionStart.json"), "utf8");
    const event = await post(
      `http://127.0.0.1:${port}/event`,
      fixture,
      "application/json",
      {},
    );
    expect(event.status).toBe(401);
    expect(JSON.parse(event.body).error).toBe("unauthorized");

    const state = await get(`http://127.0.0.1:${port}/state`, {
      origin: "http://localhost:61234",
    });
    expect(state.status).toBe(401);
    expect(JSON.parse(state.body).error).toBe("unauthorized");
  });

  it("accepts a PreToolUse Read fixture and returns read state", async () => {
    const fixture = readFileSync(join(FIXTURE_DIR, "PreToolUse_Read.json"), "utf8");
    const res = await post(`http://127.0.0.1:${port}/event`, fixture);
    const body = JSON.parse(res.body);
    expect(body.reaction.state).toBe("read");
  });

  it("exposes only privacy-minimal semantic state after a real hook payload", async () => {
    const res = await get(`http://127.0.0.1:${port}/state`, {
      origin: "http://localhost:61234",
      authorization,
    });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "http://localhost:61234",
    );
    const state = JSON.parse(res.body);
    expect(state.activity).toBe("reading");
    expect(Object.keys(state)).toEqual([
      "sessionId",
      "sequence",
      "status",
      "activity",
      "timestamp",
    ]);
    expect(res.body).not.toContain("tool_name");
    expect(res.body).not.toContain("tool_input");
  });

  it("starts an SSE subscriber with the authoritative snapshot", async () => {
    const event = await readInitialSseEvent(
      `http://127.0.0.1:${port}/stream`,
    );
    expect(event.event).toBe("snapshot");
    expect(event.data).toMatchObject({
      activity: "reading",
      status: "running",
    });
    expect(event.headers["content-type"]).toContain("text/event-stream");
    expect(event.headers["access-control-allow-origin"]).toBe(
      "http://127.0.0.1:61234",
    );
  });

  it("rejects a non-loopback browser origin from state endpoints", async () => {
    const res = await get(`http://127.0.0.1:${port}/state`, {
      origin: "https://evil.example",
      authorization,
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toBe("origin_forbidden");
  });

  it("supports authenticated CORS preflight and overlay readiness", async () => {
    const preflight = await new Promise<{
      status: number;
      headers: import("node:http").IncomingHttpHeaders;
    }>((resolveOne, rejectErr) => {
      const req = request(
        `http://127.0.0.1:${port}/overlay-ready`,
        {
          method: "OPTIONS",
          headers: {
            origin: "http://127.0.0.1:61234",
            "access-control-request-method": "POST",
            "access-control-request-headers": "authorization",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () =>
            resolveOne({
              status: res.statusCode ?? 0,
              headers: res.headers,
            }),
          );
        },
      );
      req.on("error", rejectErr);
      req.end();
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-headers"]).toContain(
      "authorization",
    );

    const before = await get(
      `http://127.0.0.1:${port}/overlay-health`,
      { authorization },
    );
    expect(before.status).toBe(503);

    const ready = await post(
      `http://127.0.0.1:${port}/overlay-ready`,
      "",
      "application/json",
      { authorization },
    );
    expect(ready.status).toBe(204);

    const after = await get(
      `http://127.0.0.1:${port}/overlay-health`,
      { authorization },
    );
    expect(after.status).toBe(200);
    expect(JSON.parse(after.body).ok).toBe(true);
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
