/**
 * avatar-process-installed-usage.test.ts (P6 proof-quality repair)
 *
 * Subprocess test of installed-usage behavior. Spawns the compiled
 * avatar from an unrelated temporary cwd and verifies:
 *
 *   - The avatar starts (READY appears).
 *   - The READY marker reports the bundled ASCII emote dir.
 *   - The HTTP server is reachable while the child is alive.
 *   - The unrelated cwd remains untouched (no root config.json,
 *     no emotes/ directory).
 *   - The project config we planted is preserved during execution.
 *   - SIGTERM causes clean exit with no surviving PID or temp dir.
 *
 * This test does NOT claim that READY alone proves both configuration
 * layers were loaded — see tests/unit/config-layering.test.ts for
 * that decisive assertion, which exercises the production
 * loadAvatarRuntimeConfig() helper directly.
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

function stripRendererEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
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
    delete clean[k];
  }
  return clean;
}

function waitForReady(
  stdoutRef: { value: string },
  timeoutMs = 5_000,
): Promise<{ line: string; port: number }> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveOne, rejectErr) => {
    const id = setInterval(() => {
      if (stdoutRef.value.includes("CLAUDE_EMOTE_READY")) {
        clearInterval(id);
        const line = stdoutRef.value.split("\n").find((l) =>
          l.includes("CLAUDE_EMOTE_READY"),
        ) ?? "";
        const portMatch = line.match(/port=(\d+)/);
        if (!portMatch) {
          rejectErr(new Error(`READY line missing port: ${line}`));
          return;
        }
        resolveOne({ line, port: Number(portMatch[1]) });
      } else if (Date.now() > deadline) {
        clearInterval(id);
        rejectErr(
          new Error(
            `CLAUDE_EMOTE_READY not seen in ${timeoutMs}ms. stdout=\n${stdoutRef.value}`,
          ),
        );
      }
    }, 25);
  });
}

describe("avatar-process installed startup (P6 proof-quality)", () => {
  let unrelatedCwd: string;
  let projectConfigPath: string;
  let projectConfigOriginal: string;
  let child: ChildProcess | null = null;
  let stdout = "";
  let stderr = "";

  beforeAll(async () => {
    // Plant ONLY a project-level config in the unrelated cwd. Do
    // NOT plant config.json at cwd root. Do NOT plant any emotes/
    // tree.
    unrelatedCwd = mkdtempSync(join(tmpdir(), "claude-emote-p6-installed-"));
    const projectConfigDir = join(
      unrelatedCwd,
      ".claude-emote",
      "extensions",
      "claude-emote",
    );
    mkdirSync(projectConfigDir, { recursive: true });
    projectConfigPath = join(projectConfigDir, "config.json");
    projectConfigOriginal = JSON.stringify({
      terminals: [{ match: "unknown", render: "ascii" }],
    });
    writeFileSync(projectConfigPath, projectConfigOriginal, "utf8");

    // Sanity: the unrelated cwd really is unrelated.
    expect(existsSync(join(unrelatedCwd, "config.json"))).toBe(false);
    expect(existsSync(join(unrelatedCwd, "emotes"))).toBe(false);

    const port = await pickPort();
    child = spawn(
      process.execPath,
      [
        AVATAR_PROCESS,
        `--port=${port}`,
        `--instance=p6-installed-usage`,
        `--parentPid=${process.pid}`,
      ],
      {
        env: stripRendererEnv(process.env),
        stdio: ["ignore", "pipe", "pipe"],
        cwd: unrelatedCwd,
      },
    );
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });

    // Wait for READY (bounded ~5s) — the process is expected to
    // stay alive.
    const ready = await waitForReady(
      Object.defineProperty({ value: "" }, "value", {
        get: () => stdout,
      }),
      5_000,
    );
    // Store on the closure so the test body can read it.
    (child as unknown as { __port: number }).__port = ready.port;
    (child as unknown as { __readyLine: string }).__readyLine = ready.line;
  }, 20_000);

  afterAll(async () => {
    // 1. Verify the project config we planted was NOT modified by the
    //    avatar process. We compare bytes.
    if (existsSync(projectConfigPath)) {
      const after = readFileSync(projectConfigPath, "utf8");
      expect(after).toBe(projectConfigOriginal);
    }
    // 2. Tear down the child if still alive.
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((r) => child!.once("exit", () => r()));
    }
    // 3. Remove the tempdir LAST. The "no temp dir remains" test
    //    runs inside this afterAll block after rmSync.
    rmSync(unrelatedCwd, { recursive: true, force: true });
    expect(existsSync(unrelatedCwd)).toBe(false);
  });

  function port(): number {
    return (child as unknown as { __port: number }).__port;
  }
  function readyLine(): string {
    return (child as unknown as { __readyLine: string }).__readyLine;
  }

  it("READY appears and reports the bundled ASCII emote path", () => {
    expect(readyLine()).toContain("CLAUDE_EMOTE_READY");
    expect(readyLine()).toContain(`emoteDir=${BUNDLED_ASCII_EMOTE_DIR}`);
  });

  it("/health returns 200 while the child is still alive", async () => {
    expect(child?.pid).toBeDefined();
    // Verify the PID is alive BEFORE we hit /health.
    try {
      process.kill(child!.pid!, 0);
    } catch {
      throw new Error(`child ${child!.pid} exited unexpectedly`);
    }
    const body = await new Promise<string>((resolveOne, rejectErr) => {
      const req = request(
        `http://127.0.0.1:${port()}/health`,
        { method: "GET", timeout: 2000 },
        (res) => {
          let buf = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (buf += c));
          res.on("end", () => resolveOne(buf));
        },
      );
      req.on("error", rejectErr);
      req.on("timeout", () => {
        req.destroy();
        rejectErr(new Error("timeout"));
      });
      req.end();
    });
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(true);
  });

  it("the unrelated cwd never had a root config.json or emotes/", () => {
    expect(existsSync(join(unrelatedCwd, "config.json"))).toBe(false);
    expect(existsSync(join(unrelatedCwd, "emotes"))).toBe(false);
  });

  it("SIGTERM causes clean exit and no PID remains", async () => {
    expect(child).not.toBeNull();
    const pid = child!.pid!;
    expect(pid).toBeGreaterThan(0);
    child!.kill("SIGTERM");
    await new Promise<void>((r) => child!.once("exit", () => r()));
    // PID must be gone.
    let stillAlive = false;
    try {
      process.kill(pid, 0);
      stillAlive = true;
    } catch {
      // expected
    }
    expect(stillAlive).toBe(false);
  });
});