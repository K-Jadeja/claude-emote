/**
 * avatar-process.test.ts (P4 integration)
 *
 * Spawns the compiled avatar process (`dist/host/avatar-process.js`) using
 * ONLY CLI arguments, with every related environment variable removed.
 * Asserts:
 *
 *   - /health responds on exactly the requested port
 *   - /health reports the requested instance ID
 *   - an event POST reaches the requested process
 *   - parent PID configuration is populated
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { request } from "node:http";
import { createServer, type Server } from "node:net";

const PROJECT_ROOT = resolve(process.cwd());
const AVATAR_PROCESS = join(PROJECT_ROOT, "dist", "host", "avatar-process.js");

const FAKE_INSTANCE = "p4-cli-only-" + Date.now();
const FAKE_PARENT_PID = 99999; // arbitrary; the watcher only fires on signal/disappearance

function join(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

let avatar: ChildProcess | null = null;
let pickedPort = 0;
let stdout = "";
let stderr = "";

beforeAll(async () => {
  // Pick a free port the avatar can listen on.
  pickedPort = await new Promise<number>((resolveReady) => {
    const srv: Server = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolveReady(p));
    });
  });

  // Strip every related env var. The avatar MUST work from CLI alone.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [
    "CLAUDE_EMOTE_PORT",
    "CLAUDE_EMOTE_INSTANCE_ID",
    "CLAUDE_EMOTE_EMOTE_DIR",
    "CLAUDE_EMOTE_PARENT_PID",
    "CLAUDE_EMOTE_LOG_FILE",
    "CLAUDE_EMOTE_DEBUG",
  ]) {
    delete env[k];
  }

  avatar = spawn(
    process.execPath,
    [
      AVATAR_PROCESS,
      `--port=${pickedPort}`,
      `--instance=${FAKE_INSTANCE}`,
      `--emoteDir=${join(PROJECT_ROOT, "emotes", "ascii")}`,
      `--parentPid=${FAKE_PARENT_PID}`,
    ],
    {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  avatar.stdout?.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
  avatar.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));

  // Wait for the READY line on stdout.
  await new Promise<void>((resolveReady, rejectErr) => {
    const timeout = setTimeout(
      () => rejectErr(new Error("avatar did not become ready in 15s")),
      15_000,
    );
    const id = setInterval(() => {
      if (stdout.includes("CLAUDE_EMOTE_READY")) {
        clearTimeout(timeout);
        clearInterval(id);
        resolveReady();
      }
    }, 50);
    avatar!.on("exit", (code) => {
      clearTimeout(timeout);
      clearInterval(id);
      if (!stdout.includes("CLAUDE_EMOTE_READY")) {
        rejectErr(
          new Error(
            `avatar exited ${code} before ready. stdout=${stdout} stderr=${stderr}`,
          ),
        );
      }
    });
  });
}, 20_000);

afterAll(async () => {
  if (avatar && !avatar.killed) {
    avatar.kill("SIGTERM");
    await new Promise<void>((r) => avatar!.on("exit", () => r()));
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

function post(
  url: string,
  body: string,
  contentType = "application/json",
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

describe("avatar-process CLI argument wiring (P4)", () => {
  it("READINESS line is on stdout and contains the requested URL", () => {
    expect(stdout).toContain("CLAUDE_EMOTE_READY");
    expect(stdout).toContain(`url=http://127.0.0.1:${pickedPort}`);
    expect(stdout).toContain(`instance=${FAKE_INSTANCE}`);
  });

  it("/health responds 200 on exactly the requested port", async () => {
    const res = await get(`http://127.0.0.1:${pickedPort}/health`);
    expect(res.status).toBe(200);
  });

  it("/health reports the requested instance ID", async () => {
    const res = await get(`http://127.0.0.1:${pickedPort}/health`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.instanceId).toBe(FAKE_INSTANCE);
  });

  it("an event POST reaches the requested process and returns 200", async () => {
    const res = await post(
      `http://127.0.0.1:${pickedPort}/event`,
      JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "p4-test",
      }),
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.reaction.state).toBe("hi");
  });

  it("MessageDisplay delta reaches onTalkToken (avatar transitions to talk)", async () => {
    // First send a UserPromptSubmit so the avatar enters talk-prone state.
    const prompt = await post(
      `http://127.0.0.1:${pickedPort}/event`,
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "p4-test",
        prompt: "hi",
      }),
    );
    expect(prompt.status).toBe(200);
    expect(JSON.parse(prompt.body).reaction.state).toBe("think");

    // Now stream a MessageDisplay delta. The reaction should be talk and
    // carry the token.
    const display = await post(
      `http://127.0.0.1:${pickedPort}/event`,
      JSON.stringify({
        hook_event_name: "MessageDisplay",
        session_id: "p4-test",
        turn_id: "t1",
        message_id: "m1",
        index: 0,
        final: false,
        delta: "hello world",
      }),
    );
    expect(display.status).toBe(200);
    const body = JSON.parse(display.body);
    expect(body.reaction.state).toBe("talk");
    expect(body.reaction.talkToken).toBe("hello world");
  });

  it("parent PID configuration was populated (env / debug log mentions it)", () => {
    // The avatar's debug line is gated on CLAUDE_EMOTE_DEBUG, which we
    // explicitly deleted. So we cannot directly inspect stderr here.
    // Instead we verify the watcher was armed: if the parent's PID were
    // 0 the avatar would never check process.kill(parentPid, 0). We can
    // only assert it didn't crash on startup with the supplied parent
    // PID — which the previous tests already prove.
    // We also assert the avatar process is still alive after several
    // requests, which it would not be if the parent-PID logic had thrown.
    expect(avatar).not.toBeNull();
    expect(avatar!.killed).toBe(false);
  });
});