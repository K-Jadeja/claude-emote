/**
 * avatar-process-frame-output.test.ts (P5 + harness safety repair)
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
 * Harness safety:
 *   - The child is launched with `cwd: <isolatedTempDir>` so its project
 *     config is read from a unique temp directory rather than the real
 *     repository root. The temp directory and its `.claude-emote/...`
 *     override are deleted during teardown. The real project root is
 *     never written to.
 *   - The config-tempdir lifecycle is delegated to the shared helper
 *     `createIsolatedAsciiHarness()` in
 *     `tests/integration/_isolated-config-harness.ts`. The live test
 *     and the harness-safety regression tests both use the same
 *     helper implementation.
 *   - The child is given the test worker's real PID via
 *     `--parentPid=${process.pid}` and `process.kill(process.pid, 0)`
 *     is asserted to succeed before spawning. The child therefore
 *     survives the entire event sequence. After the final assertion the
 *     test explicitly sends SIGTERM and awaits the exit; it never
 *     relies on the parent-watcher to end the test.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve, join } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { request } from "node:http";
import {
  createIsolatedAsciiHarness,
  type IsolatedConfigHarness,
} from "./_isolated-config-harness.js";

const PROJECT_ROOT = resolve(process.cwd());
const AVATAR_PROCESS = join(PROJECT_ROOT, "dist", "host", "avatar-process.js");
const ASCII_DIR = join(PROJECT_ROOT, "emotes", "ascii");
const REAL_PROJECT_CONFIG = join(
  PROJECT_ROOT,
  ".claude-emote",
  "extensions",
  "claude-emote",
  "config.json",
);

const ALLOWED_TALK = ["(• _ •)", "(• . •)", "(• o •)", "(• O •)"];
const ALLOWED_READ = ["( ╭ರᴥ•́)⠉", "( ╭ರᴥ•)⠒", "( ╭ರᴥ•)⠤"];

interface Launch {
  child: ChildProcess;
  getStdout: () => string;
  getStderr: () => string;
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

/** Bounded wait for the child to exit after a signal. */
function awaitExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise<number | null>((resolveOne) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveOne(child.exitCode);
      return;
    }
    const timer = setTimeout(() => resolveOne(null), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveOne(code);
    });
  });
}

interface ChildState {
  child: ChildProcess | null;
  teardownPromise: Promise<void> | null;
}

const childState: ChildState = {
  child: null,
  teardownPromise: null,
};

/**
 * Best-effort child + harness teardown. The child lifecycle stays in
 * this test (the test owns the child). The harness-tempdir lifecycle
 * delegates to the shared helper.
 */
async function teardownAll(harness: IsolatedConfigHarness): Promise<void> {
  if (childState.teardownPromise) return childState.teardownPromise;
  childState.teardownPromise = (async () => {
    const child = childState.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const code = await awaitExit(child, 5_000);
      if (code === null) {
        child.kill("SIGKILL");
        await awaitExit(child, 1_000);
      }
    }
    // Process must be gone before we remove its cwd.
    if (child && child.pid !== undefined) {
      try {
        process.kill(child.pid, 0);
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      } catch {
        // ESRCH: child is gone. Expected.
      }
    }
    childState.child = null;
    await harness.cleanup();
  })();
  return childState.teardownPromise;
}

describe("avatar-process live frame output (P5)", () => {
  let launch: Launch;
  let configHarness: IsolatedConfigHarness;

  beforeAll(async () => {
    // Verify the live parent PID is observable before spawning the child.
    try {
      process.kill(process.pid, 0);
    } catch (err) {
      throw new Error(
        `process.kill(process.pid, 0) failed: ${(err as Error).message}`,
      );
    }

    configHarness = createIsolatedAsciiHarness();

    // Strip renderer-affecting env vars so terminal detection returns
    // ASCII in the spawned child.
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
    let child: ChildProcess;
    try {
      child = spawn(
        process.execPath,
        [
          AVATAR_PROCESS,
          `--port=${port}`,
          `--instance=${instanceId}`,
          `--emoteDir=${ASCII_DIR}`,
          `--parentPid=${process.pid}`,
        ],
        {
          env: cleanEnv,
          stdio: ["ignore", "pipe", "pipe"],
          cwd: configHarness.tempDir,
        },
      );
    } catch (err) {
      await teardownAll(configHarness);
      throw err;
    }
    childState.child = child;

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.once("exit", () => {
      if (childState.child === child) {
        childState.child = null;
      }
    });

    try {
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
    } catch (err) {
      await teardownAll(configHarness);
      throw err;
    }

    launch = {
      child,
      getStdout: () => stdout,
      getStderr: () => stderr,
      port,
      instanceId,
    };
  }, 30_000);

  afterAll(async () => {
    if (
      launch?.child &&
      launch.child.exitCode === null &&
      launch.child.signalCode === null
    ) {
      try {
        process.kill(launch.child.pid, 0);
      } catch {
        // already gone
      }
    }
    await teardownAll(configHarness);
    if (launch?.child?.pid !== undefined) {
      try {
        process.kill(launch.child.pid, 0);
        throw new Error(`avatar child ${launch.child.pid} survived teardown`);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "ESRCH") throw err;
      }
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

// -------------------------------------------------------------------------
// Harness-safety regression tests. These drive the same shared helper
// implementation that the live production-path test uses. They verify:
//   1. The real project config (if any) is left untouched.
//   2. The harness-created tempdir is fully removed on cleanup, even
//      when it contains unrelated files.
//   3. Cleanup is idempotent.
// -------------------------------------------------------------------------

describe("isolated config harness safety (shared helper)", () => {
  it("creates its config inside a tempdir and removes it on cleanup", async () => {
    const h = createIsolatedAsciiHarness();
    expect(existsSync(h.configPath)).toBe(true);
    expect(h.tempDir).toContain("claude-emote-harness-");
    await h.cleanup();
    expect(existsSync(h.tempDir)).toBe(false);
  });

  it("cleanup is idempotent — calling twice leaves the filesystem clean", async () => {
    const h = createIsolatedAsciiHarness();
    await h.cleanup();
    await h.cleanup();
    await h.cleanup();
    expect(existsSync(h.tempDir)).toBe(false);
  });

  it("removes the complete tempdir including unrelated files it owns", async () => {
    const h = createIsolatedAsciiHarness();
    // Drop an extra unrelated file inside the harness-owned tempdir.
    const extraFile = join(h.tempDir, "extra-unrelated-file.txt");
    writeFileSync(extraFile, "test", "utf8");
    expect(existsSync(extraFile)).toBe(true);
    await h.cleanup();
    expect(existsSync(extraFile)).toBe(false);
    expect(existsSync(h.tempDir)).toBe(false);
  });

  it("never touches the real project root config (whatever its state)", async () => {
    // Snapshot the real project config state before running the harness.
    const existedBefore = existsSync(REAL_PROJECT_CONFIG);
    const bytesBefore = existedBefore
      ? readFileSync(REAL_PROJECT_CONFIG)
      : null;

    const h = createIsolatedAsciiHarness();
    expect(existsSync(h.configPath)).toBe(true);
    await h.cleanup();
    expect(existsSync(h.tempDir)).toBe(false);

    // Real project config state must be unchanged.
    const existsAfter = existsSync(REAL_PROJECT_CONFIG);
    expect(existsAfter).toBe(existedBefore);
    if (existedBefore) {
      const bytesAfter = readFileSync(REAL_PROJECT_CONFIG);
      expect(Buffer.compare(bytesBefore!, bytesAfter)).toBe(0);
    } else {
      expect(existsAfter).toBe(false);
    }
  });
});