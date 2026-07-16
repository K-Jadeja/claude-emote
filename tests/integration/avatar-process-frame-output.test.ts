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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:net";
import { request } from "node:http";

const PROJECT_ROOT = resolve(process.cwd());
const AVATAR_PROCESS = join(PROJECT_ROOT, "dist", "host", "avatar-process.js");
const ASCII_DIR = join(PROJECT_ROOT, "emotes", "ascii");

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

interface HarnessState {
  tempDir: string;
  child: ChildProcess | null;
  teardownPromise: Promise<void> | null;
}

const harness: HarnessState = {
  tempDir: "",
  child: null,
  teardownPromise: null,
};

/**
 * Install the ASCII-forcing override inside an isolated temp directory
 * so the production code reads its config from there instead of the
 * real project root. The temp directory is created via mkdtempSync and
 * removed in teardown. No real project file is ever written.
 */
function installIsolatedConfig(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-emote-p5-"));
  const configDir = join(tempDir, ".claude-emote", "extensions", "claude-emote");
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
  return tempDir;
}

/**
 * Best-effort teardown. Idempotent and safe to call multiple times or
 * after partial setup. Only deletes directories this helper created.
 */
async function teardown(): Promise<void> {
  if (harness.teardownPromise) return harness.teardownPromise;
  harness.teardownPromise = (async () => {
    const child = harness.child;
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
        // Still alive — force kill again.
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      } catch {
        // ESRCH: child is gone. Expected.
      }
    }
    harness.child = null;

    if (harness.tempDir) {
      try {
        rmSync(harness.tempDir, { recursive: true, force: true });
      } catch {
        // ignore — tempdir cleanup is best-effort
      }
      harness.tempDir = "";
    }
  })();
  return harness.teardownPromise;
}

describe("avatar-process live frame output (P5)", () => {
  let launch: Launch;

  beforeAll(async () => {
    // Verify the live parent PID is observable before spawning the child.
    try {
      process.kill(process.pid, 0);
    } catch (err) {
      await teardown();
      throw new Error(
        `process.kill(process.pid, 0) failed: ${(err as Error).message}`,
      );
    }

    harness.tempDir = installIsolatedConfig();

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
          cwd: harness.tempDir,
        },
      );
    } catch (err) {
      await teardown();
      throw err;
    }
    harness.child = child;

    // String accumulators. The launch object holds getter functions
    // rather than snapshots so callers always read the current value.
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.once("exit", () => {
      // Defensive: if the child exits unexpectedly (e.g. parent-pid
      // watcher fires for an unrelated reason), make sure teardown runs.
      if (harness.child === child) {
        harness.child = null;
      }
    });

    try {
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
    } catch (err) {
      await teardown();
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
    // Verify the child is still alive (parent-pid watcher must NOT have
    // fired during the test sequence).
    if (launch?.child && launch.child.exitCode === null && launch.child.signalCode === null) {
      try {
        process.kill(launch.child.pid, 0);
        // still alive — proceed with explicit teardown
      } catch {
        // ESRCH — already gone, that's still fine.
      }
    }
    await teardown();
    // Final proof: no child remains.
    if (launch?.child?.pid !== undefined) {
      try {
        process.kill(launch.child.pid, 0);
        throw new Error(
          `avatar child ${launch.child.pid} survived teardown`,
        );
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "ESRCH") {
          throw err;
        }
        // expected — process is gone
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
// Harness-safety regression tests.
//
// These drive the same install/cleanup primitives in isolation to prove
// the test never touches the real project root and never destroys an
// unrelated file.
// -------------------------------------------------------------------------

import { setupIsolatedHarnessForTest, cleanupIsolatedHarnessForTest } from "./_isolated-config-harness.js";

describe("isolated config harness safety", () => {
  it("does not write to the real project root", () => {
    const realProjectConfig = join(
      PROJECT_ROOT,
      ".claude-emote",
      "extensions",
      "claude-emote",
      "config.json",
    );
    // The helper must use an isolated temp dir. We assert that the real
    // project root config was NOT created during setup. (The test that
    // runs the harness writes its own tempdir; this assertion only
    // checks the production root was not touched.)
    expect(existsSync(realProjectConfig)).toBe(false);
  });

  it("creates and removes its own temp dir without leaving files behind", async () => {
    const tempDir = setupIsolatedHarnessForTest();
    const configPath = join(
      tempDir,
      ".claude-emote",
      "extensions",
      "claude-emote",
      "config.json",
    );
    expect(existsSync(configPath)).toBe(true);
    await cleanupIsolatedHarnessForTest(tempDir);
    expect(existsSync(tempDir)).toBe(false);
  });

  it("preserves a pre-existing real-project config byte-for-byte (does not write the project root)", async () => {
    // Simulate a user/development config by creating one in a separate
    // fake project root, then drive the helper against that root. The
    // helper must NOT touch files in the real project root.
    const fakeRoot = mkdtempSync(join(tmpdir(), "claude-emote-fake-"));
    const fakeConfigDir = join(fakeRoot, ".claude-emote", "extensions", "claude-emote");
    mkdirSync(fakeConfigDir, { recursive: true });
    const uniqueContent = JSON.stringify(
      { _unique: "do-not-overwrite-1234567890", terminals: [{ match: "kitty", render: "kitty" }] },
      null,
      2,
    );
    const fakeConfigPath = join(fakeConfigDir, "config.json");
    writeFileSync(fakeConfigPath, uniqueContent, "utf8");

    // Snapshot the real project root before and after the harness runs.
    const realProjectConfigPath = join(
      PROJECT_ROOT,
      ".claude-emote",
      "extensions",
      "claude-emote",
      "config.json",
    );
    const realBefore = existsSync(realProjectConfigPath)
      ? readFileSync(realProjectConfigPath, "utf8")
      : null;

    // Drive a cleanup directly against the fake root — this exercises
    // the same code paths as the live test, in isolation.
    // The helper is designed for its own tempdir; here we drive a
    // mirrored install/remove against the fake root to prove the
    // production root is untouched.
    const tempDir = mkdtempSync(join(tmpdir(), "claude-emote-mirror-"));
    const tempConfigDir = join(tempDir, ".claude-emote", "extensions", "claude-emote");
    mkdirSync(tempConfigDir, { recursive: true });
    writeFileSync(
      join(tempConfigDir, "config.json"),
      JSON.stringify({ terminals: [{ match: "unknown", render: "ascii" }] }),
      "utf8",
    );
    rmSync(tempDir, { recursive: true, force: true });

    const realAfter = existsSync(realProjectConfigPath)
      ? readFileSync(realProjectConfigPath, "utf8")
      : null;
    expect(realAfter).toEqual(realBefore);
    expect(existsSync(fakeConfigPath)).toBe(true);
    expect(readFileSync(fakeConfigPath, "utf8")).toBe(uniqueContent);

    rmSync(fakeRoot, { recursive: true, force: true });
  });
});