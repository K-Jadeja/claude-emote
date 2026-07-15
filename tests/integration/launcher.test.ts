/**
 * launcher.test.ts (P3 integration, isolated)
 *
 * Drives the compiled launcher (`dist/launcher/claude-emote.js`) against
 * a fake `claude` script and a fake `avatar` script. Both are tiny node
 * programs:
 *
 *   - fake-claude.js: writes its argv + env to RECORD_PATH, then exits
 *     with the value of FAKE_CLAUDE_EXIT_CODE (default 0).
 *   - fake-avatar.js: parses --port from argv, listens on 127.0.0.1:port,
 *     replies 200 to /health, replies 200 to /event, stays running.
 *
 * The launcher is given CLAUDE_EMOTE_CLAUDE_EXE and CLAUDE_EMOTE_AVATAR_EXE
 * so it never tries to locate the real claude binary or run the real
 * avatar process. The fake avatar's /health responds immediately, so no
 * Windows Terminal pane, no real renderer, no Chafa is required.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const PROJECT_ROOT = resolve(process.cwd());
const LAUNCHER = join(PROJECT_ROOT, "dist", "launcher", "claude-emote.js");
const NODE = process.execPath;

const FAKE_DIR = join(tmpdir(), "claude-emote-fake-" + Date.now());
const FAKE_CLAUDE_PATH = join(FAKE_DIR, "claude.js");
const FAKE_AVATAR_PATH = join(FAKE_DIR, "avatar.js");
const RECORD_PATH = join(FAKE_DIR, "fake-claude-record.json");
const PIDS_PATH = join(FAKE_DIR, "fake-avatar-pids.json");

beforeAll(() => {
  mkdirSync(FAKE_DIR, { recursive: true });

  writeFileSync(
    FAKE_CLAUDE_PATH,
    `
const fs = require("node:fs");
const recordPath = process.env.FAKE_CLAUDE_RECORD;
const exitCode = Number(process.env.FAKE_CLAUDE_EXIT_CODE || 0);
const payload = {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
  hasFakeExit: "FAKE_CLAUDE_EXIT_CODE" in process.env,
};
fs.writeFileSync(recordPath, JSON.stringify(payload, null, 2));
process.exit(exitCode);
`,
    "utf8",
  );

  // Seed the PID log so the fake avatar can append safely.
  writeFileSync(PIDS_PATH, "[]\n", "utf8");

  // Fake avatar: parses --port, listens on 127.0.0.1:port, replies 200 to
  // /health and /event. Stays running until the parent (the launcher)
  // exits. We do not need to forward events to the Animator because the
  // test is checking the launcher's wiring, not the avatar server's
  // event handling.
  //
  // On startup, the fake avatar appends its own PID + start time to
  // FAKE_AVATAR_PIDS_FILE so the regression test can later check that
  // the launcher killed it.
  writeFileSync(
    FAKE_AVATAR_PATH,
    `
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
let port = 0;
let instance = "test";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && i + 1 < args.length) port = Number(args[++i]);
  if (args[i] === "--instance" && i + 1 < args.length) instance = args[++i];
  const m = args[i].match(/^--port=(.+)$/); if (m) port = Number(m[1]);
  const mi = args[i].match(/^--instance=(.+)$/); if (mi) instance = mi[1];
}
if (!port) { console.error("fake avatar: --port missing"); process.exit(2); }

const pidsPath = process.env.FAKE_AVATAR_PIDS_FILE;
if (pidsPath) {
  try {
    const list = JSON.parse(fs.readFileSync(pidsPath, "utf8"));
    list.push({ pid: process.pid, port, startedAt: Date.now() });
    fs.writeFileSync(pidsPath, JSON.stringify(list, null, 2));
  } catch {}
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, instanceId: instance }));
    return;
  }
  if (req.method === "POST" && req.url === "/event") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
    return;
  }
  res.statusCode = 404;
  res.end();
});
server.listen(port, "127.0.0.1", () => {
  console.log("FAKE_AVATAR_READY port=" + port + " instance=" + instance + " pid=" + process.pid);
});
`,
    "utf8",
  );
});

afterAll(() => {
  try {
    rmSync(FAKE_DIR, { recursive: true, force: true });
  } catch {}
});

interface FakeRecord {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function readRecord(): FakeRecord {
  return JSON.parse(readFileSync(RECORD_PATH, "utf8"));
}

interface RunResult {
  code: number;
  stderr: string;
  stdout: string;
}

function runLauncher(
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  return new Promise((resolveOne, rejectErr) => {
    const child: ChildProcess = spawn(NODE, [LAUNCHER, ...args], {
      env: {
        ...process.env,
        ...extraEnv,
        CLAUDE_EMOTE_CLAUDE_EXE: FAKE_CLAUDE_PATH,
        CLAUDE_EMOTE_AVATAR_EXE: FAKE_AVATAR_PATH,
        // Test mode: launcher spawns the avatar as an attached child and
        // waits for it to exit before itself exiting. No visible windows,
        // no detached processes.
        CLAUDE_EMOTE_TEST_MODE: "1",
        CLAUDE_EMOTE_DEBUG: "1",
        FAKE_CLAUDE_RECORD: RECORD_PATH,
        FAKE_AVATAR_PIDS_FILE: PIDS_PATH,
        // Force non-Windows-Terminal path so the test does not depend on WT.
        WT_SESSION: "",
        LOCALAPPDATA: FAKE_DIR,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stdout?.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectErr(
        new Error(
          `launcher timed out after 20s. stderr:\n${stderr}\nstdout:\n${stdout}`,
        ),
      );
    }, 20_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      rejectErr(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveOne({ code: code ?? 0, stderr, stdout });
    });
  });
}

const TEST_TIMEOUT = 30_000;

describe("launcher (P3 integration, isolated)", () => {
  it("sanity: fake executables exist on disk", () => {
    expect(existsSync(FAKE_CLAUDE_PATH)).toBe(true);
    expect(existsSync(FAKE_AVATAR_PATH)).toBe(true);
  });

  it(
    "selects CLAUDE_EMOTE_CLAUDE_EXE and logs it",
    { timeout: TEST_TIMEOUT },
    async () => {
      const { stderr } = await runLauncher(["--resume"], {
        CLAUDE_EMOTE_DEBUG: "1",
      });
      expect(stderr).toContain(`claude exe: override = ${FAKE_CLAUDE_PATH}`);
      // The debug log must not say "on PATH".
      expect(stderr).not.toMatch(/claude exe: on PATH/);
    },
  );

  it(
    "spawns the avatar and the fake claude; adds --plugin-dir at the package root",
    { timeout: TEST_TIMEOUT },
    async () => {
      const { code, stderr } = await runLauncher(["--resume"]);
      if (code !== 0) {
        throw new Error(`launcher exited ${code}; stderr:\n${stderr}`);
      }
      const rec = readRecord();
      const idx = rec.argv.indexOf("--plugin-dir");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(rec.argv[idx + 1]).toBe(PROJECT_ROOT);
    },
  );

  it(
    "preserves user arguments in their original order",
    { timeout: TEST_TIMEOUT },
    async () => {
      const userArgs = [
        "--resume",
        "--model",
        "opus",
        "--dangerously-skip-permissions",
      ];
      const { code, stderr } = await runLauncher(userArgs);
      if (code !== 0) {
        throw new Error(`launcher exited ${code}; stderr:\n${stderr}`);
      }
      const rec = readRecord();
      const startIdx = rec.argv.indexOf(userArgs[0]);
      expect(startIdx).toBeGreaterThanOrEqual(0);
      for (let i = 0; i < userArgs.length; i++) {
        expect(rec.argv[startIdx + i]).toBe(userArgs[i]);
      }
    },
  );

  it(
    "preserves an unrelated --plugin-dir and still injects the claude-emote plugin-dir",
    { timeout: TEST_TIMEOUT },
    async () => {
      const { code, stderr } = await runLauncher([
        "--plugin-dir",
        "C:/other/plugin",
      ]);
      if (code !== 0) {
        throw new Error(`launcher exited ${code}; stderr:\n${stderr}`);
      }
      const rec = readRecord();
      // Two --plugin-dir flags: the user's then claude-emote's.
      const occurrences = rec.argv.filter((a) => a === "--plugin-dir").length;
      expect(occurrences).toBe(2);
      // The user-provided one keeps its original value.
      const userDirIdx = rec.argv.indexOf("C:/other/plugin");
      expect(userDirIdx).toBeGreaterThanOrEqual(0);
      expect(rec.argv[userDirIdx - 1]).toBe("--plugin-dir");
      // claude-emote's plugin dir is appended.
      const last = rec.argv[rec.argv.length - 1];
      expect(last).toBe(PROJECT_ROOT);
      expect(rec.argv[rec.argv.length - 2]).toBe("--plugin-dir");
    },
  );

  it(
    "does not duplicate --plugin-dir when the user already pointed at PROJECT_ROOT",
    { timeout: TEST_TIMEOUT },
    async () => {
      const { code, stderr } = await runLauncher([
        "--plugin-dir",
        PROJECT_ROOT,
      ]);
      if (code !== 0) {
        throw new Error(`launcher exited ${code}; stderr:\n${stderr}`);
      }
      const rec = readRecord();
      const occurrences = rec.argv.filter((a) => a === "--plugin-dir").length;
      expect(occurrences).toBe(1);
    },
  );

  it(
    "propagates CLAUDE_EMOTE_INSTANCE_ID, CLAUDE_EMOTE_ENDPOINT, and CLAUDE_EMOTE_PARENT_PID in env",
    { timeout: TEST_TIMEOUT },
    async () => {
      const { code, stderr } = await runLauncher(["--resume"]);
      if (code !== 0) {
        throw new Error(`launcher exited ${code}; stderr:\n${stderr}`);
      }
      const rec = readRecord();
      expect(rec.env.CLAUDE_EMOTE_INSTANCE_ID).toBeDefined();
      expect(typeof rec.env.CLAUDE_EMOTE_INSTANCE_ID).toBe("string");
      expect(rec.env.CLAUDE_EMOTE_INSTANCE_ID!.length).toBeGreaterThan(0);
      expect(rec.env.CLAUDE_EMOTE_ENDPOINT).toBeDefined();
      expect(rec.env.CLAUDE_EMOTE_ENDPOINT).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/event$/,
      );
      expect(rec.env.CLAUDE_EMOTE_PARENT_PID).toBeDefined();
      expect(Number(rec.env.CLAUDE_EMOTE_PARENT_PID)).toBeGreaterThan(0);
    },
  );

  it(
    "forwards claude's exit code",
    { timeout: TEST_TIMEOUT },
    async () => {
      const { code, stderr } = await runLauncher([], {
        FAKE_CLAUDE_EXIT_CODE: "7",
      });
      if (code !== 7) {
        let rec: FakeRecord | undefined;
        try { rec = readRecord(); } catch {}
        throw new Error(
          `expected exit 7, got ${code}. record=${JSON.stringify(rec)} stderr:\n${stderr}`,
        );
      }
    },
  );

  it(
    "--version returns without launching the avatar (no port allocated, no plugin-dir injected)",
    { timeout: TEST_TIMEOUT },
    async () => {
      const { code, stderr } = await runLauncher(["--version"], {
        CLAUDE_EMOTE_DEBUG: "1",
      });
      if (code !== 0) {
        throw new Error(`launcher exited ${code}; stderr:\n${stderr}`);
      }
      // The version path must never log the avatar exe — proof the
      // orchestration skipped port allocation and avatar launch.
      expect(stderr).not.toMatch(/avatar exe:/);
      expect(stderr).not.toMatch(/port=\d+ instance=/);
      // The fake claude's record must NOT have CLAUDE_EMOTE_ENDPOINT.
      const rec = readRecord();
      expect(rec.env.CLAUDE_EMOTE_ENDPOINT).toBeUndefined();
      // The fake claude's argv must include --version.
      expect(rec.argv).toContain("--version");
      // And must NOT include --plugin-dir.
      expect(rec.argv).not.toContain("--plugin-dir");
    },
  );

  it(
    "three consecutive launcher runs leave zero fake-avatar processes (no orphan windows)",
    { timeout: TEST_TIMEOUT * 2 },
    async () => {
      // Reset the PID log so we only count avatars from this test.
      writeFileSync(PIDS_PATH, "[]\n", "utf8");

      for (let i = 0; i < 3; i++) {
        const { code, stderr } = await runLauncher(["--resume"], {});
        if (code !== 0) {
          throw new Error(
            `run #${i + 1}: launcher exited ${code}; stderr:\n${stderr}`,
          );
        }
        // Each run's debug log must record test-mode avatar spawn and
        // explicit termination.
        expect(stderr).toMatch(/avatar exe:/);
        expect(stderr).toMatch(/claude child closed/);
      }

      // The fake avatar wrote one PID per launch into PIDS_PATH.
      const recorded: Array<{ pid: number; port: number; startedAt: number }> =
        JSON.parse(readFileSync(PIDS_PATH, "utf8"));
      expect(recorded.length).toBe(3);

      // Verify each recorded PID is no longer alive. `process.kill(pid, 0)`
      // throws ESRCH when the pid does not exist. A successful call (no
      // throw) means the pid still exists and the launcher leaked it.
      const survivors: number[] = [];
      for (const entry of recorded) {
        try {
          process.kill(entry.pid, 0);
          // On Windows, kill(0) succeeds for any existing process, even
          // if we lack permission to send a signal. Treat that as "still
          // alive".
          survivors.push(entry.pid);
        } catch (err) {
          // ESRCH on POSIX = no such process. On Windows, EINVAL is also
          // possible. Either way: the pid is gone.
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ESRCH" && code !== "EINVAL") {
            throw err;
          }
        }
      }
      expect(survivors).toEqual([]);
    },
  );
});
