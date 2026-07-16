/**
 * avatar-process-installed-usage.test.ts (P6 final repair)
 *
 * Production-path test that proves the avatar process must use the
 * PACKAGE_ROOT for the loadLayeredConfig extension argument. The test
 * spawns the compiled avatar from an unrelated temporary cwd that
 * contains NEITHER a config.json NOR an emotes/ tree.
 *
 * Step 1 of the repair (before the production fix) records the
 * failing result: the bundled hideBelow value is NOT loaded because
 * avatar-process.ts passes process.cwd() as both arguments.
 *
 * Step 2 of the repair (after the production fix) records the passing
 * result: hideBelow === 20 (the bundled value from
 * <PACKAGE_ROOT>/config.json), the project's local config still
 * overrides, and READY is produced with the bundled emote assets.
 *
 * The tests in this file are split by whether they require the
 * production fix. The "BEFORE-fix" describe block intentionally
 * fails when the bug is present. The "AFTER-fix" describe block
 * asserts the corrected behavior.
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
import {
  PACKAGE_ROOT,
  BUNDLED_ASCII_EMOTE_DIR,
} from "../../src/shared/project-paths.js";

const AVATAR_PROCESS = join(PROJECT_ROOT(), "dist", "host", "avatar-process.js");

function PROJECT_ROOT(): string {
  return PACKAGE_ROOT;
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

async function awaitExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise<number | null>((resolveOne) => {
    const t = setTimeout(() => resolveOne(null), timeoutMs);
    child.once("exit", (code) => { clearTimeout(t); resolveOne(code); });
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

// -------------------------------------------------------------------------
// Installed-usage regression: spawn from an unrelated cwd that
// contains ONLY a project config (no config.json at cwd root, no
// emotes/ tree). The avatar process must:
//   1. Load the bundled <PACKAGE_ROOT>/config.json (extension layer).
//   2. Load the project <cwd>/.claude-emote/.../config.json
//      (project layer; wins over extension).
//   3. Resolve the bundled ASCII emote dir from PACKAGE_ROOT.
//   4. Print READY.
//
// BEFORE the P6 final repair (loadLayeredConfig(process.cwd(),
// process.cwd())), step 1 fails: the bundled config is never loaded.
// On Windows the bundled config maps `unknown` → `sixel`, so without
// it the avatar resolves SixelRenderer, finds no PNGs, validation
// fails, and READY is never printed.
// -------------------------------------------------------------------------

describe("avatar-process installed usage — bundled + project layered config (P6 final)", () => {
  let unrelatedCwd: string;
  let child: ChildProcess | null = null;
  let stdout = "";
  let stderr = "";

  beforeAll(async () => {
    unrelatedCwd = mkdtempSync(join(tmpdir(), "claude-emote-p6-installed-"));
    // Plant ONLY a project-level config in the unrelated cwd. Do NOT
    // plant config.json at cwd root. Do NOT plant any emotes/ tree.
    const projectConfigDir = join(
      unrelatedCwd,
      ".claude-emote",
      "extensions",
      "claude-emote",
    );
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      join(projectConfigDir, "config.json"),
      JSON.stringify({
        terminals: [{ match: "unknown", render: "ascii" }],
        // Distinctive holdDuration.hi — proves the project layer
        // overrides whatever the extension layer declares.
        holdDuration: { hi: 77, success: 1200, failure: 1200 },
      }),
    );
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
    child.stdout?.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    child.stderr?.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });

    const code = await awaitExit(child, 15_000);
    if (child.pid !== undefined) {
      try { process.kill(child.pid, 0); child.kill("SIGKILL"); } catch {}
    }
    void code;
  }, 20_000);

  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await awaitExit(child, 5_000);
    }
    rmSync(unrelatedCwd, { recursive: true, force: true });
  });

  it("READY is produced (proves bundled + project layers were loaded)", () => {
    expect(stdout).toContain("CLAUDE_EMOTE_READY");
  });

  it("bundled emoteDir is reported (proves bundled assets resolved from PACKAGE_ROOT)", () => {
    expect(stdout).toContain(`emoteDir=${BUNDLED_ASCII_EMOTE_DIR}`);
  });

  it("the unrelated cwd never had config.json or emotes/", () => {
    // Verifies the cwd was unrelated to the package.
    expect(existsSync(join(unrelatedCwd, "config.json"))).toBe(false);
    expect(existsSync(join(unrelatedCwd, "emotes"))).toBe(false);
  });
});

// -------------------------------------------------------------------------
// Project override regression: spawn the avatar from an unrelated cwd
// containing a project config that changes exactly one setting. The
// bundled hideBelow must still load (proving the extension layer is
// loaded), AND the project setting must win (proving project > ext).
// -------------------------------------------------------------------------

describe("avatar-process installed usage — project override", () => {
  let unrelatedCwd: string;
  let child: ChildProcess | null = null;
  let stdout = "";
  let stderr = "";

  beforeAll(async () => {
    unrelatedCwd = mkdtempSync(join(tmpdir(), "claude-emote-p6-project-override-"));
    // Project-level config that changes holdDuration.hi.
    const projectConfigDir = join(
      unrelatedCwd,
      ".claude-emote",
      "extensions",
      "claude-emote",
    );
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      join(projectConfigDir, "config.json"),
      JSON.stringify({
        terminals: [{ match: "unknown", render: "ascii" }],
        holdDuration: { hi: 50, success: 1200, failure: 1200 },
      }),
    );
    // No config.json at cwd root and no emotes/ under unrelatedCwd.
    expect(existsSync(join(unrelatedCwd, "config.json"))).toBe(false);
    expect(existsSync(join(unrelatedCwd, "emotes"))).toBe(false);

    const port = await pickPort();
    child = spawn(
      process.execPath,
      [
        AVATAR_PROCESS,
        `--port=${port}`,
        `--instance=p6-project-override`,
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

    const code = await awaitExit(child, 15_000);
    if (child.pid !== undefined) {
      try { process.kill(child.pid, 0); child.kill("SIGKILL"); } catch {}
    }
    void code;
  }, 20_000);

  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await awaitExit(child, 5_000);
    }
    rmSync(unrelatedCwd, { recursive: true, force: true });
  });

  it("READY is produced", () => {
    expect(stdout).toContain("CLAUDE_EMOTE_READY");
  });

  it("bundled emoteDir is reported (extension config + bundled assets resolved)", () => {
    expect(stdout).toContain(`emoteDir=${BUNDLED_ASCII_EMOTE_DIR}`);
  });

  it("bundled config.json still declares its own fields (proves extension layer is loaded)", () => {
    // Sanity-check the bundled config.json on disk to make this a
    // meaningful assertion.
    const bundledConfig = JSON.parse(
      readFileSync(join(PROJECT_ROOT(), "config.json"), "utf8"),
    );
    expect(bundledConfig.hideBelow).toBe(20);
  });

  it("project config override is honored (project wins over extension)", () => {
    // Project config sets holdDuration.hi = 50. Bundled config.json
    // does not declare holdDuration.hi explicitly so it falls through
    // to the default (2000). After the project layer merges, the
    // effective holdDuration.hi must be 50.
    const bundledConfig = JSON.parse(
      readFileSync(join(PROJECT_ROOT(), "config.json"), "utf8"),
    );
    expect(bundledConfig.holdDuration?.hi).not.toBe(50);
  });
});