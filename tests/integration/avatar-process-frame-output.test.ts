/**
 * avatar-process-frame-output.test.ts (P5)
 *
 * Production-path integration test: spawns the COMPILED avatar process,
 * waits for its READY marker, then POSTs real hook-shaped events and
 * asserts that captured stdout eventually contains the real ASCII frames
 * for each state.
 *
 * Anti-cheating rules:
 *   - The test reads captured stdout. It never writes frame strings.
 *   - It never calls host.setCurrentFrame / writeRaw / console.log of a
 *     frame. The frame delivery comes from the production renderer path
 *     inside the spawned child.
 *   - The spawned child has detached:false, shell:false, stdio
 *     pipe-only. No visible terminal window, no start, no cmd /c, no
 *     wt.exe, no unref(), no real Claude.
 *
 * Forced renderer: the test strips every TERM_PROGRAM/WT_SESSION/etc
 * variable so terminal detection falls back to ASCII. This is the same
 * pattern the existing avatar-server test relies on.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { request } from "node:http";

const PROJECT_ROOT = resolve(process.cwd());
const AVATAR_PROCESS = join(PROJECT_ROOT, "dist", "host", "avatar-process.js");
const ASCII_DIR = join(PROJECT_ROOT, "emotes", "ascii");

// Force the spawned child to select the ASCII renderer through the
// project's existing supported configuration mechanism: a layered
// project config that overrides the default "unknown" terminal mapping.
// The defaults would otherwise resolve to "sixel" on Windows, which would
// never load ascii.yaml and so no frames would ever be drawn.
const PROJECT_CONFIG_DIR = join(
  PROJECT_ROOT,
  ".claude-emote",
  "extensions",
  "claude-emote",
);
const PROJECT_CONFIG_PATH = join(PROJECT_CONFIG_DIR, "config.json");

const ALLOWED_TALK = ["(• _ •)", "(• . •)", "(• o •)", "(• O •)"];
const ALLOWED_READ = ["( ╭ರᴥ•́)⠉", "( ╭ರᴥ•)⠒", "( ╭ರᴥ•)⠤"];

interface Launch {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  port: number;
  instanceId: string;
}

async function pickPort(): Promise<number> {
  return new Promise<number>((resolveOne) => {
    const srv: Server = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolveOne(p));
    });
  });
}

function postJson(
  url: string,
  body: string,
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
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        timeout: 3000,
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

async function waitForOutput(
  out: { value: string },
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `waitForOutput: predicate not satisfied in ${timeoutMs}ms\ncaptured:\n${out.value}`,
  );
}

describe("avatar-process live frame output (P5)", () => {
  let launch: Launch;

  beforeAll(async () => {
    // Write the temporary project config that forces ASCII selection.
    mkdirSync(PROJECT_CONFIG_DIR, { recursive: true });
    writeFileSync(
      PROJECT_CONFIG_PATH,
      JSON.stringify(
        { terminals: [{ match: "unknown", render: "ascii" }] },
        null,
        2,
      ),
      "utf8",
    );

    // Strip renderer-affecting env vars so terminal detection returns
    // ASCII in the spawned child. This is the same strip used by the
    // avatar-server test, applied through a fresh env.
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
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
      delete cleanEnv[k];
    }

    const port = await pickPort();
    const instanceId = "phase5-frame-test";
    const child: ChildProcess = spawn(
      process.execPath,
      [
        AVATAR_PROCESS,
        `--port=${port}`,
        `--instance=${instanceId}`,
        `--emoteDir=${ASCII_DIR}`,
        `--parentPid=99999`,
      ],
      {
        env: cleanEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    // String accumulators. The launch object holds getter functions rather
    // than snapshots so callers always read the current value.
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });

    // Wait for READY marker.
    await new Promise<void>((resolveOne, rejectErr) => {
      const deadline = setTimeout(
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
          clearTimeout(deadline);
          clearInterval(id);
          resolveOne();
        }
      }, 50);
      child.on("exit", (code) => {
        clearTimeout(deadline);
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

    launch = {
      child,
      getStdout: () => stdout,
      getStderr: () => stderr,
      port,
      instanceId,
    };
  }, 30_000);

  afterAll(async () => {
    if (launch?.child && !launch.child.killed) {
      launch.child.kill("SIGTERM");
      await new Promise<void>((r) => launch.child.on("exit", () => r()));
    }
    // Clean up the temporary project config so other test files do not
    // see it. Use try/catch in case the write in beforeAll failed.
    try {
      rmSync(PROJECT_CONFIG_PATH, { force: true });
    } catch {
      // ignore
    }
  });

  function capStdout() {
    return launch.getStdout();
  }

  it("SessionStart → hi frame appears on stdout through the production renderer path", async () => {
    await postJson(
      `http://127.0.0.1:${launch.port}/event`,
      JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "phase5",
      }),
    );
    const out = { value: "" };
    Object.defineProperty(out, "value", { get: () => capStdout() });
    await waitForOutput(out, () => out.value.includes("(^ ◡ ^)/"), 3000);
  });

  it("UserPromptSubmit → think frame appears on stdout", async () => {
    await postJson(
      `http://127.0.0.1:${launch.port}/event`,
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "phase5",
        prompt: "test",
      }),
    );
    const out = { value: "" };
    Object.defineProperty(out, "value", { get: () => capStdout() });
    await waitForOutput(
      out,
      () => out.value.includes("(•_ • )?") || out.value.includes("(-᷅_ -᷄\") "),
      3000,
    );
  });

  it("MessageDisplay → one of the talk frames appears on stdout", async () => {
    await postJson(
      `http://127.0.0.1:${launch.port}/event`,
      JSON.stringify({
        hook_event_name: "MessageDisplay",
        session_id: "phase5",
        turn_id: "turn-1",
        message_id: "message-1",
        index: 0,
        final: false,
        delta: "hello from Claude",
      }),
    );
    const out = { value: "" };
    Object.defineProperty(out, "value", { get: () => capStdout() });
    await waitForOutput(
      out,
      () => ALLOWED_TALK.some((f) => out.value.includes(f)),
      3000,
    );
  });

  it("PreToolUse Read → one of the read frames appears on stdout", async () => {
    await postJson(
      `http://127.0.0.1:${launch.port}/event`,
      JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "phase5",
        tool_name: "Read",
        tool_input: {},
      }),
    );
    const out = { value: "" };
    Object.defineProperty(out, "value", { get: () => capStdout() });
    await waitForOutput(
      out,
      () => ALLOWED_READ.some((f) => out.value.includes(f)),
      3000,
    );
  });

  it("Stop → idle frame appears on stdout", async () => {
    await postJson(
      `http://127.0.0.1:${launch.port}/event`,
      JSON.stringify({
        hook_event_name: "Stop",
        session_id: "phase5",
      }),
    );
    const out = { value: "" };
    Object.defineProperty(out, "value", { get: () => capStdout() });
    await waitForOutput(out, () => out.value.includes("(• ◡ •)"), 3000);
  });
});