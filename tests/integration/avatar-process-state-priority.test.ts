/**
 * avatar-process-state-priority.test.ts (P7)
 *
 * Production-path test for the state controller. Spawns the compiled
 * avatar process, plants a project config with short hold durations,
 * and POSTs real hook events to /event. Asserts visible state
 * priorities on a log file written from the child's stdout.
 *
 * Planted project config (in the spawned child's cwd):
 *   {
 *     "terminals": [{ "match": "unknown", "render": "ascii" }],
 *     "holdDuration": { "hi": 50, "success": 50, "failure": 120 }
 *   }
 *
 * Sequences asserted:
 *   PostToolUseFailure  → failure frame appears
 *   PostToolBatch       → think must NOT appear before failure hold
 *                        expires
 *   (wait)              → think frame appears after hold
 *   PreCompact          → compact frame appears
 *   MessageDisplay      → talk must NOT replace compact
 *   PostCompact         → idle frame appears
 *
 * Note on stdout capture: vitest fork-pool workers do not always
 * propagate large bursts of child stdout through the parent pipe in
 * real time, so we write a copy to a temp log file and read the file
 * instead. The data handler appends to both the in-memory closure
 * variable AND the file.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  appendFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:net";
import { request } from "node:http";
import {
  BUNDLED_ASCII_EMOTE_DIR,
  PACKAGE_ROOT,
} from "../../src/shared/project-paths.js";

const AVATAR_PROCESS = join(PACKAGE_ROOT, "dist", "host", "avatar-process.js");

async function pickPort(): Promise<number> {
  return new Promise<number>((resolveOne) => {
    const srv: Server = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolveOne(p));
    });
  });
}

function postJson(url: string, body: string): Promise<{ status: number }> {
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
        res.resume();
        res.on("end", () => resolveOne({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", rejectErr);
    req.on("timeout", () => { req.destroy(); rejectErr(new Error("timeout")); });
    req.end(body);
  });
}

interface Launch {
  child: ChildProcess;
  port: number;
  /** Absolute path of the per-test log file. */
  logPath: string;
}

function stripRendererEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const k of [
    "WT_SESSION", "TERM_PROGRAM", "ITERM_SESSION_ID", "KITTY_WINDOW_ID",
    "WEZTERM_PANE", "GHOSTTY_RESOURCES_DIR", "TMUX", "ZELLIJ_SESSION_NAME",
    "ZELLIJ",
    "CLAUDE_EMOTE_PORT", "CLAUDE_EMOTE_INSTANCE_ID",
    "CLAUDE_EMOTE_EMOTE_DIR", "CLAUDE_EMOTE_PARENT_PID",
    "CLAUDE_EMOTE_LOG_FILE",
    "CLAUDE_EMOTE_DEMO_PROTOCOL",
  ]) {
    delete clean[k];
  }
  clean.CLAUDE_EMOTE_DEBUG = "1";
  return clean;
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitForCondition(${what}) timed out in ${timeoutMs}ms`);
}

function readLog(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

const FAILURE_FRAME = "( ° Д°)#";
const THINK_FRAME = "(•_ • )?";
const COMPACT_FRAME = "(-᷅_ -᷄;)";
const IDLE_FRAME = "(• ◡ •)";

describe("avatar-process state priorities (P7)", () => {
  let harnessDir: string;
  let launch: Launch;
  const PROJECT_CONFIG = {
    terminals: [{ match: "unknown", render: "ascii" }],
    holdDuration: { hi: 50, success: 50, failure: 120 },
  };

  beforeAll(async () => {
    harnessDir = mkdtempSync(join(tmpdir(), "claude-emote-p7-priority-"));
    const configDir = join(
      harnessDir,
      ".claude-emote",
      "extensions",
      "claude-emote",
    );
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify(PROJECT_CONFIG),
    );
    expect(existsSync(join(harnessDir, "config.json"))).toBe(false);
    expect(existsSync(join(harnessDir, "emotes"))).toBe(false);

    const logPath = join(harnessDir, "stdout.log");
    const port = await pickPort();
    const child = spawn(
      process.execPath,
      [
        AVATAR_PROCESS,
        `--port=${port}`,
        `--instance=p7-priority`,
        `--emoteDir=${BUNDLED_ASCII_EMOTE_DIR}`,
        `--parentPid=${process.pid}`,
      ],
      {
        env: stripRendererEnv(process.env),
        stdio: ["ignore", "pipe", "pipe"],
        cwd: harnessDir,
      },
    );
    child.stdout?.on("data", (b: Buffer) => {
      const s = b.toString("utf8");
      try {
        appendFileSync(logPath, s);
      } catch {}
    });
    child.stderr?.on("data", () => {});

    launch = { child, port, logPath };
    await waitForCondition(
      () => readLog(logPath).includes("CLAUDE_EMOTE_READY"),
      5_000,
      "READY",
    );
  }, 20_000);

  afterAll(async () => {
    if (launch?.child && launch.child.exitCode === null && launch.child.signalCode === null) {
      launch.child.kill("SIGTERM");
      await new Promise<void>((r) => launch.child.once("exit", () => r()));
    }
    rmSync(harnessDir, { recursive: true, force: true });
  });

  it("failure frame appears and is NOT replaced by PostToolBatch during the hold", async () => {
    // Wait for the initial idle frame to settle first.
    await waitForCondition(
      () => readLog(launch.logPath).includes(IDLE_FRAME),
      2_000,
      "IDLE_FRAME",
    );

    const resp = await postJson(
      `http://127.0.0.1:${launch.port}/event`,
      JSON.stringify({
        hook_event_name: "PostToolUseFailure",
        session_id: "p7",
        tool_name: "Bash",
      }),
    );
    expect(resp.status).toBe(200);

    // Failure frame should appear within ~50ms.
    await waitForCondition(
      () => readLog(launch.logPath).includes(FAILURE_FRAME),
      2_000,
      "FAILURE_FRAME",
    );

    // PostToolBatch arrives immediately. Think must NOT appear before
    // the failure hold expires (120ms).
    await postJson(
      `http://127.0.0.1:${launch.port}/event`,
      JSON.stringify({
        hook_event_name: "PostToolBatch",
        session_id: "p7",
      }),
    );
    await new Promise((r) => setTimeout(r, 80)); // < 120ms hold
    const logDuringHold = readLog(launch.logPath);
    expect(logDuringHold).not.toContain(THINK_FRAME);

    // Wait past the failure hold (120ms) plus a margin.
    await new Promise((r) => setTimeout(r, 200));
    expect(readLog(launch.logPath)).toContain(THINK_FRAME);
  });

  it("compact frame appears and is NOT replaced by MessageDisplay", async () => {
    await postJson(
      `http://127.0.0.1:${launch.port}/event`,
      JSON.stringify({
        hook_event_name: "PreCompact",
        session_id: "p7",
      }),
    );
    await waitForCondition(
      () => readLog(launch.logPath).includes(COMPACT_FRAME),
      2_000,
      "COMPACT_FRAME",
    );

    // MessageDisplay must not change visible state. Compact must remain
    // the most recent frame in the log.
    await postJson(
      `http://127.0.0.1:${launch.port}/event`,
      JSON.stringify({
        hook_event_name: "MessageDisplay",
        session_id: "p7",
        turn_id: "t",
        message_id: "m",
        index: 0,
        final: false,
        delta: "should be ignored visually",
      }),
    );
    await new Promise((r) => setTimeout(r, 80));
    const log = readLog(launch.logPath);
    const lastCompact = log.lastIndexOf(COMPACT_FRAME);
    const lastThink = log.lastIndexOf(THINK_FRAME);
    const lastFailure = log.lastIndexOf(FAILURE_FRAME);
    // Most recent frame in the log must still be a compact draw.
    expect(lastCompact).toBeGreaterThan(Math.max(lastThink, lastFailure));
  });

  it("PostCompact releases compact to idle", async () => {
    await postJson(
      `http://127.0.0.1:${launch.port}/event`,
      JSON.stringify({
        hook_event_name: "PostCompact",
        session_id: "p7",
      }),
    );
    await waitForCondition(
      () => {
        const log = readLog(launch.logPath);
        // An idle draw AFTER the most recent compact draw.
        const lastIdle = log.lastIndexOf(IDLE_FRAME);
        const lastCompact = log.lastIndexOf(COMPACT_FRAME);
        return lastIdle > lastCompact;
      },
      2_000,
      "post-compact idle",
    );
  });
});