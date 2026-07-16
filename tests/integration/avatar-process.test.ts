/**
 * avatar-process.test.ts (P4 correctness repair)
 *
 * Spawns the compiled avatar process (`dist/host/avatar-process.js`)
 * using ONLY CLI arguments, with every related environment variable
 * removed. Verifies:
 *
 *   - /health responds on the actual bound port (even when --port=0)
 *   - /health reports the requested instance ID and the actual port
 *   - an event POST reaches the requested process
 *   - the retained parentPid equals the requested one (read from the
 *     READY marker on stdout)
 *   - the --port=0 launch is observable end-to-end via the actual port
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve, join } from "node:path";
import { request } from "node:http";
import { createServer, type Server } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const PROJECT_ROOT = resolve(process.cwd());
const AVATAR_PROCESS = join(PROJECT_ROOT, "dist", "host", "avatar-process.js");

function join(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

interface AvatarLaunch {
  child: ChildProcess;
  readyMarker: string;
  port: number;
  instanceId: string;
  parentPid: string;
}

// Phase 6: the avatar process validates the resolved emote dir
// against the resolved renderer. The bundled ASCII dir is text-only;
// an image renderer (sixel on Windows) would reject it. This test
// suite uses an isolated cwd with an ASCII-forcing layered config so
// the child always picks the ASCII renderer, and the bundled ASCII
// dir is automatically selected when no --emoteDir is supplied.
const HARNESS_DIR = mkdtempSync(join(tmpdir(), "claude-emote-avatar-process-"));
{
  const configDir = join(HARNESS_DIR, ".claude-emote", "extensions", "claude-emote");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ terminals: [{ match: "unknown", render: "ascii" }] }),
  );
}

async function launch(args: string[]): Promise<AvatarLaunch> {
  // Strip every related env var. The avatar MUST work from CLI alone.
  const env: NodeJS.ProcessEnv = { ...process.env };
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
  ]) {
    delete env[k];
  }

  const child: ChildProcess = spawn(
    process.execPath,
    [AVATAR_PROCESS, ...args],
    {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: HARNESS_DIR,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
  child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));

  // Wait for the READY line on stdout.
  await new Promise<void>((resolveReady, rejectErr) => {
    const timeout = setTimeout(
      () =>
        rejectErr(
          new Error(
            `avatar did not become ready in 15s. stdout=${stdout} stderr=${stderr}`,
          ),
        ),
      15_000,
    );
    const id = setInterval(() => {
      if (stdout.includes("CLAUDE_EMOTE_READY")) {
        clearTimeout(timeout);
        clearInterval(id);
        resolveReady();
      }
    }, 50);
    child.on("exit", (code) => {
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

  const urlMatch = stdout.match(/url=(http:\/\/127\.0\.0\.1:\d+)/);
  const portMatch = stdout.match(/port=(\d+)/);
  const instanceMatch = stdout.match(/instance=(\S+)/);
  const parentMatch = stdout.match(/parentPid=(\S+)/);
  if (!urlMatch || !portMatch || !instanceMatch || !parentMatch) {
    throw new Error(
      `READY marker missing fields. stdout=${stdout} stderr=${stderr}`,
    );
  }
  return {
    child,
    readyMarker: stdout,
    port: Number(portMatch[1]),
    instanceId: instanceMatch[1]!,
    parentPid: parentMatch[1]!,
  };
}

function httpGet(
  url: string,
): Promise<{ status: number; body: string }> {
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

function httpPost(
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
        res.on("end", () =>
          resolveOne({ status: res.statusCode ?? 0, body: buf }),
        );
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

async function pickPort(): Promise<number> {
  return new Promise<number>((resolveReady) => {
    const srv: Server = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolveReady(p));
    });
  });
}

describe("avatar-process CLI wiring (P4)", () => {
  describe("requested CLI args drive the wired avatar", () => {
    let launchInfo: AvatarLaunch;
    beforeAll(async () => {
      const port = await pickPort();
      launchInfo = await launch([
        `--port=${port}`,
        `--instance=p4-cli-only`,
        `--emoteDir=${join(PROJECT_ROOT, "emotes", "ascii")}`,
        `--parentPid=99999`,
      ]);
    }, 20_000);
    afterAll(async () => {
      launchInfo.child.kill("SIGTERM");
      await new Promise<void>((r) => launchInfo.child.on("exit", () => r()));
    });

    it("READY marker is on stdout and contains the requested URL, port, instance, parentPid", () => {
      expect(launchInfo.readyMarker).toContain("CLAUDE_EMOTE_READY");
      expect(launchInfo.readyMarker).toContain(
        `url=http://127.0.0.1:${launchInfo.port}`,
      );
      expect(launchInfo.readyMarker).toContain("instance=p4-cli-only");
      expect(launchInfo.readyMarker).toContain("parentPid=99999");
    });

    it("/health responds 200 on the actual bound port", async () => {
      const res = await httpGet(`http://127.0.0.1:${launchInfo.port}/health`);
      expect(res.status).toBe(200);
    });

    it("/health reports the requested instance ID and the actual port", async () => {
      const res = await httpGet(`http://127.0.0.1:${launchInfo.port}/health`);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.instanceId).toBe("p4-cli-only");
      expect(body.port).toBe(launchInfo.port);
    });

    it("an event POST reaches the process and returns the mapped reaction", async () => {
      const res = await httpPost(
        `http://127.0.0.1:${launchInfo.port}/event`,
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

    it("MessageDisplay delta reaches onTalkToken (avatar returns talk with the token)", async () => {
      const display = await httpPost(
        `http://127.0.0.1:${launchInfo.port}/event`,
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

    it("the requested parentPid is retained by the process", () => {
      expect(launchInfo.parentPid).toBe("99999");
    });
  });

  describe("port-zero launch", () => {
    let launchInfo: AvatarLaunch;
    beforeAll(async () => {
      launchInfo = await launch([
        "--port=0",
        "--instance=port-zero-test",
        `--emoteDir=${join(PROJECT_ROOT, "emotes", "ascii")}`,
        "--parentPid=99999",
      ]);
    }, 20_000);
    afterAll(async () => {
      launchInfo.child.kill("SIGTERM");
      await new Promise<void>((r) => launchInfo.child.on("exit", () => r()));
    });

    it("the assigned port is a positive integer", () => {
      expect(launchInfo.port).toBeGreaterThan(0);
      expect(Number.isInteger(launchInfo.port)).toBe(true);
    });

    it("does not claim port 0 after listening", () => {
      expect(launchInfo.port).not.toBe(0);
    });

    it("/health.port equals the actual bound port", async () => {
      const res = await httpGet(`http://127.0.0.1:${launchInfo.port}/health`);
      const body = JSON.parse(res.body);
      expect(body.port).toBe(launchInfo.port);
      expect(body.instanceId).toBe("port-zero-test");
    });

    it("the server is reachable on the actual reported port", async () => {
      const res = await httpGet(`http://127.0.0.1:${launchInfo.port}/health`);
      expect(res.status).toBe(200);
    });
  });
});

// Cleanup the harness cwd at module teardown.
afterAll(() => {
  rmSync(HARNESS_DIR, { recursive: true, force: true });
});