/**
 * avatar-process-emote-selection.test.ts (P6)
 *
 * Direct compiled-process tests for Phase 6 emote-set selection.
 *
 *   Test A: automatic ASCII selection from a temp cwd with the
 *           bundled ASCII dir selected automatically (no --emoteDir).
 *   Test B: cwd independence — runs from an unrelated temp cwd with
 *           no emotes/ copied in. Automatic selection must still
 *           succeed via the bundled path.
 *   Test C: invalid custom path (nonexistent) exits nonzero with a
 *           clear stderr line and never prints READY.
 *   Test D: incompatible custom path (image dir fed to ASCII
 *           renderer) exits nonzero with a clear compatibility
 *           error and never prints READY.
 *   Test E: valid custom ASCII path is honored — process starts and
 *           the custom frame appears on stdout; the bundled frame
 *           is NOT substituted.
 *
 * The shared isolated config harness from Phase 5 is used to force
 * ASCII selection. No visible windows. No real Claude. No writes
 * under the real project root.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve, join } from "node:path";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:net";
import { request } from "node:http";
import { createIsolatedAsciiHarness } from "./_isolated-config-harness.js";
import {
  PACKAGE_ROOT,
  BUNDLED_ASCII_EMOTE_DIR,
  BUNDLED_IMAGE_EMOTE_DIR,
} from "../../src/shared/project-paths.js";

const AVATAR_PROCESS = join(PACKAGE_ROOT, "dist", "host", "avatar-process.js");
const ASCII_DIR_BUNDLED = BUNDLED_ASCII_EMOTE_DIR;
const IMAGE_DIR_BUNDLED = BUNDLED_IMAGE_EMOTE_DIR;

async function pickPort(): Promise<number> {
  return new Promise<number>((resolveOne) => {
    const srv: Server = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolveOne(p));
    });
  });
}

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveOne, rejectErr) => {
    const req = request(url, { method: "GET", timeout: 3000 }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (buf += c));
      res.on("end", () => resolveOne({ status: res.statusCode ?? 0, body: buf }));
    });
    req.on("error", rejectErr);
    req.on("timeout", () => { req.destroy(); rejectErr(new Error("timeout")); });
    req.end();
  });
}

interface Launch {
  child: ChildProcess;
  getStdout: () => string;
  getStderr: () => string;
  port: number;
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
    `predicate not satisfied in ${timeoutMs}ms\ncaptured:\n${out.value}`,
  );
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

async function awaitExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise<number | null>((resolveOne) => {
    const t = setTimeout(() => resolveOne(null), timeoutMs);
    child.once("exit", (code) => { clearTimeout(t); resolveOne(code); });
  });
}

// -------------------------------------------------------------------------
// Test A: automatic ASCII selection
// -------------------------------------------------------------------------

describe("avatar-process automatic ASCII selection (P6 Test A)", () => {
  let harness: ReturnType<typeof createIsolatedAsciiHarness>;
  let child: ChildProcess | null = null;
  let stdout = "";
  let stderr = "";
  let port = 0;

  beforeAll(async () => {
    harness = createIsolatedAsciiHarness();
    port = await pickPort();
    child = spawn(
      process.execPath,
      [
        AVATAR_PROCESS,
        `--port=${port}`,
        `--instance=p6-auto-ascii`,
        `--parentPid=${process.pid}`,
      ],
      {
        env: stripRendererEnv(process.env),
        stdio: ["ignore", "pipe", "pipe"],
        cwd: harness.tempDir,
      },
    );
    child.stdout?.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    child.stderr?.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });

    // Wait for READY.
    const out = { value: "" };
    Object.defineProperty(out, "value", { get: () => stdout });
    await waitForOutput(out, () => out.value.includes("CLAUDE_EMOTE_READY"), 15_000);
  }, 30_000);

  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await awaitExit(child, 5_000);
    }
    if (child?.pid !== undefined) {
      try { process.kill(child.pid, 0); child.kill("SIGKILL"); } catch {}
    }
    await harness.cleanup();
  });

  it("READY appears", () => {
    expect(stdout).toContain("CLAUDE_EMOTE_READY");
  });

  it("READY line includes the bundled ASCII directory", () => {
    // Phase 6: the READY marker exposes the effective emote dir so
    // the test can verify automatic selection landed on the bundled
    // ASCII directory.
    expect(stdout).toContain(`emoteDir=${ASCII_DIR_BUNDLED}`);
  });

  it("/health responds 200", async () => {
    const res = await get(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
  });

  it("an idle ASCII frame appears in stdout (proves renderer-driven delivery)", async () => {
    // The transition to idle happens during startup. The frame should
    // be in stdout well before the test timeout.
    await waitForOutput({ value: stdout }, () => stdout.includes("(• ◡ •)"), 5_000);
  });
});

// -------------------------------------------------------------------------
// Test B: cwd independence — runs from an unrelated temp cwd
// -------------------------------------------------------------------------

describe("avatar-process cwd independence (P6 Test B)", () => {
  let unrelatedCwd: string;
  let child: ChildProcess | null = null;
  let stdout = "";
  let stderr = "";
  let port = 0;

  beforeAll(async () => {
    // The child must be launched from a directory that has NO emotes/
    // inside it. We also plant the ASCII-forcing config into the
    // unrelated cwd's expected layered-config location so the
    // terminal-detection still picks ASCII, but we never plant any
    // emotes/ directory under unrelatedCwd. The whole point: the
    // bundled emote dir must be resolved from PACKAGE_ROOT, not
    // from cwd.
    unrelatedCwd = mkdtempSync(join(tmpdir(), "claude-emote-p6-cwd-"));
    // Plant the ASCII override at unrelatedCwd/.claude-emote/... but
    // do NOT plant any emotes/ tree.
    const configDir = join(unrelatedCwd, ".claude-emote", "extensions", "claude-emote");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ terminals: [{ match: "unknown", render: "ascii" }] }),
    );
    expect(existsSync(join(unrelatedCwd, "emotes"))).toBe(false);

    port = await pickPort();
    child = spawn(
      process.execPath,
      [
        AVATAR_PROCESS,
        `--port=${port}`,
        `--instance=p6-cwd-indep`,
        `--parentPid=${process.pid}`,
      ],
      {
        env: stripRendererEnv(process.env),
        stdio: ["ignore", "pipe", "pipe"],
        cwd: unrelatedCwd,
      },
    );
    child.stdout?.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    child.stderr?.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });

    const out = { value: "" };
    Object.defineProperty(out, "value", { get: () => stdout });
    await waitForOutput(out, () => out.value.includes("CLAUDE_EMOTE_READY"), 15_000);
  }, 30_000);

  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await awaitExit(child, 5_000);
    }
    if (child?.pid !== undefined) {
      try { process.kill(child.pid, 0); child.kill("SIGKILL"); } catch {}
    }
    rmSync(unrelatedCwd, { recursive: true, force: true });
  });

  it("READY appears from the unrelated cwd", () => {
    expect(stdout).toContain("CLAUDE_EMOTE_READY");
  });

  it("effective emote dir is the bundled ASCII dir, not the cwd", () => {
    expect(stdout).toContain(`emoteDir=${ASCII_DIR_BUNDLED}`);
    expect(stdout).not.toContain(`emoteDir=${unrelatedCwd}`);
  });

  it("/health responds 200 from the unrelated cwd", async () => {
    const res = await get(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
  });
});

// -------------------------------------------------------------------------
// Test C: invalid custom path (nonexistent)
// -------------------------------------------------------------------------

describe("avatar-process invalid custom path (P6 Test C)", () => {
  let harness: ReturnType<typeof createIsolatedAsciiHarness>;
  let child: ChildProcess | null = null;
  let stdout = "";
  let stderr = "";
  let port = 0;

  beforeAll(async () => {
    harness = createIsolatedAsciiHarness();
    port = await pickPort();
    child = spawn(
      process.execPath,
      [
        AVATAR_PROCESS,
        `--port=${port}`,
        `--instance=p6-bad-path`,
        `--emoteDir=${join(tmpdir(), "claude-emote-p6-NOPE-" + Date.now())}`,
        `--parentPid=${process.pid}`,
      ],
      {
        env: stripRendererEnv(process.env),
        stdio: ["ignore", "pipe", "pipe"],
        cwd: harness.tempDir,
      },
    );
    child.stdout?.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    child.stderr?.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });

    // Wait for the child to exit (it should exit fast on bad config).
    const code = await awaitExit(child, 5_000);
    // Verify no surviving process.
    if (child.pid !== undefined) {
      try {
        process.kill(child.pid, 0);
        child.kill("SIGKILL");
        await awaitExit(child, 1_000);
      } catch {
        // already gone
      }
    }
    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
  }, 30_000);

  afterAll(async () => {
    await harness.cleanup();
  });

  it("exits with a clear stderr error", () => {
    expect(stderr).toMatch(/invalid emote set/);
    expect(stderr).toMatch(/does not exist/);
  });

  it("does not print CLAUDE_EMOTE_READY", () => {
    expect(stdout).not.toContain("CLAUDE_EMOTE_READY");
  });
});

// -------------------------------------------------------------------------
// Test D: incompatible custom path (image dir fed to ASCII renderer)
// -------------------------------------------------------------------------

describe("avatar-process incompatible custom path (P6 Test D)", () => {
  let harness: ReturnType<typeof createIsolatedAsciiHarness>;
  let child: ChildProcess | null = null;
  let stdout = "";
  let stderr = "";
  let port = 0;

  beforeAll(async () => {
    harness = createIsolatedAsciiHarness();
    port = await pickPort();
    child = spawn(
      process.execPath,
      [
        AVATAR_PROCESS,
        `--port=${port}`,
        `--instance=p6-incompat`,
        // Force ASCII in config (via the harness) but pass an
        // image-only directory as the custom path.
        `--emoteDir=${IMAGE_DIR_BUNDLED}`,
        `--parentPid=${process.pid}`,
      ],
      {
        env: stripRendererEnv(process.env),
        stdio: ["ignore", "pipe", "pipe"],
        cwd: harness.tempDir,
      },
    );
    child.stdout?.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    child.stderr?.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    const code = await awaitExit(child, 5_000);
    if (child.pid !== undefined) {
      try { process.kill(child.pid, 0); child.kill("SIGKILL"); } catch {}
    }
    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
  }, 30_000);

  afterAll(async () => {
    await harness.cleanup();
  });

  it("exits with a clear compatibility error", () => {
    expect(stderr).toMatch(/invalid emote set/);
    expect(stderr).toMatch(/ascii\.yaml not found/);
  });

  it("does not print CLAUDE_EMOTE_READY", () => {
    expect(stdout).not.toContain("CLAUDE_EMOTE_READY");
  });
});

// -------------------------------------------------------------------------
// Test E: valid custom ASCII path is honored
// -------------------------------------------------------------------------

describe("avatar-process valid custom ASCII path (P6 Test E)", () => {
  let harness: ReturnType<typeof createIsolatedAsciiHarness>;
  let customAsciiDir: string;
  let child: ChildProcess | null = null;
  let stdout = "";
  let stderr = "";
  let port = 0;
  const CUSTOM_HI = "(CUSTOM HI)";
  const CUSTOM_IDLE = "(CUSTOM IDLE)";

  beforeAll(async () => {
    // Build an isolated custom ASCII dir containing a distinctive
    // ascii.yaml so we can prove the bundled set is NOT substituted.
    customAsciiDir = mkdtempSync(join(tmpdir(), "claude-emote-p6-custom-"));
    writeFileSync(
      join(customAsciiDir, "ascii.yaml"),
      [
        "hi:",
        `  default: "${CUSTOM_HI}"`,
        "idle:",
        `  default: "${CUSTOM_IDLE}"`,
        "",
      ].join("\n"),
    );

    harness = createIsolatedAsciiHarness();
    port = await pickPort();
    child = spawn(
      process.execPath,
      [
        AVATAR_PROCESS,
        `--port=${port}`,
        `--instance=p6-custom-ok`,
        `--emoteDir=${customAsciiDir}`,
        `--parentPid=${process.pid}`,
      ],
      {
        env: stripRendererEnv(process.env),
        stdio: ["ignore", "pipe", "pipe"],
        cwd: harness.tempDir,
      },
    );
    child.stdout?.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    child.stderr?.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });

    const out = { value: "" };
    Object.defineProperty(out, "value", { get: () => stdout });
    await waitForOutput(out, () => out.value.includes("CLAUDE_EMOTE_READY"), 15_000);
  }, 30_000);

  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await awaitExit(child, 5_000);
    }
    if (child?.pid !== undefined) {
      try { process.kill(child.pid, 0); child.kill("SIGKILL"); } catch {}
    }
    await harness.cleanup();
    rmSync(customAsciiDir, { recursive: true, force: true });
  });

  it("READY appears and reports the custom dir", () => {
    expect(stdout).toContain("CLAUDE_EMOTE_READY");
    expect(stdout).toContain(`emoteDir=${customAsciiDir}`);
    expect(stdout).not.toContain(`emoteDir=${ASCII_DIR_BUNDLED}`);
  });

  it("the custom idle frame appears on stdout", async () => {
    await waitForOutput(
      { value: stdout },
      () => stdout.includes(CUSTOM_IDLE),
      5_000,
    );
  });

  it("the bundled idle frame is NOT substituted", () => {
    // "(• ◡ •)" is the bundled idle frame. It must NOT appear
    // because we forced a custom path.
    expect(stdout).not.toContain("(• ◡ •)");
  });
});

// -------------------------------------------------------------------------
// Test F: readiness-order regression — zero-frame renderer must NOT
// reach READY. We construct an isolated EMPTY custom dir and verify
// the process exits before printing READY.
// -------------------------------------------------------------------------

describe("readiness-order regression (P6)", () => {
  let harness: ReturnType<typeof createIsolatedAsciiHarness>;
  let emptyAsciiDir: string;
  let child: ChildProcess | null = null;
  let stdout = "";
  let stderr = "";
  let port = 0;

  beforeAll(async () => {
    // Isolated EMPTY custom dir (no ascii.yaml inside). Validation
    // fails fast at startup.
    emptyAsciiDir = mkdtempSync(join(tmpdir(), "claude-emote-p6-empty-"));
    // Create the dir but put NO ascii.yaml inside.
    mkdirSync(emptyAsciiDir, { recursive: true });
    writeFileSync(join(emptyAsciiDir, "README.txt"), "no assets here");

    harness = createIsolatedAsciiHarness();
    port = await pickPort();
    child = spawn(
      process.execPath,
      [
        AVATAR_PROCESS,
        `--port=${port}`,
        `--instance=p6-zero-frames`,
        `--emoteDir=${emptyAsciiDir}`,
        `--parentPid=${process.pid}`,
      ],
      {
        env: stripRendererEnv(process.env),
        stdio: ["ignore", "pipe", "pipe"],
        cwd: harness.tempDir,
      },
    );
    child.stdout?.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    child.stderr?.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    await awaitExit(child, 5_000);
    if (child.pid !== undefined) {
      try { process.kill(child.pid, 0); child.kill("SIGKILL"); } catch {}
    }
  }, 30_000);

  afterAll(async () => {
    await harness.cleanup();
    rmSync(emptyAsciiDir, { recursive: true, force: true });
  });

  it("exits before reaching READY when the custom set has no usable ASCII frame", () => {
    expect(stdout).not.toContain("CLAUDE_EMOTE_READY");
    expect(stderr).toMatch(/invalid emote set/);
    expect(stderr).toMatch(/ascii\.yaml not found/);
  });
});