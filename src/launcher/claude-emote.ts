#!/usr/bin/env node
/**
 * claude-emote.ts
 *
 * The `claude-emote` launcher.
 *
 * Phase 3 contract:
 *   1. Verify that the `claude` executable is reachable. The launcher
 *      prefers the explicit override `CLAUDE_EMOTE_CLAUDE_EXE` (used by
 *      integration tests) and asserts which executable was selected.
 *   2. If argv contains --version / -v, spawn the version probe and
 *      return immediately. No port allocation, no avatar pane.
 *   3. Otherwise: allocate a port, generate an instance ID, launch the
 *      avatar process (whose path is taken from `CLAUDE_EMOTE_AVATAR_EXE`
 *      when set, otherwise from dist/host/avatar-process.js), wait for
 *      /health, then spawn `claude` with the original argv + --plugin-dir
 *      pointing at the package root.
 *
 * Test seams (kept narrow, named clearly so they're easy to spot in a
 * code review):
 *   - CLAUDE_EMOTE_CLAUDE_EXE   override the resolved claude executable
 *   - CLAUDE_EMOTE_AVATAR_EXE   override the avatar process binary
 *
 * Both seams are test-only entry points; they do not implement any
 * Phase 4 / Phase 6 / Phase 8 behaviour.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { request } from "node:http";

import {
  PROJECT_ROOT,
  AVATAR_PROCESS,
  isVersionArgv,
  buildClaudeArgs,
} from "./args.js";

const debug = process.env.CLAUDE_EMOTE_DEBUG === "1";
function dbg(msg: string): void {
  if (debug) process.stderr.write(`[claude-emote] ${msg}\n`);
}

function findExecutable(name: string, envPath: string): string | null {
  const exts = process.platform === "win32" ? [".cmd", ".bat", ".exe", ""] : [""];
  const dirs = envPath.split(process.platform === "win32" ? ";" : ":");
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolve the claude executable. Order:
 *   1. CLAUDE_EMOTE_CLAUDE_EXE env var (test seam).
 *   2. claude on PATH.
 *
 * The chosen path is logged and returned.
 */
function resolveClaudeExe(): string | null {
  const override = process.env.CLAUDE_EMOTE_CLAUDE_EXE;
  if (override) {
    dbg(`claude exe: override = ${override}`);
    return override;
  }
  const onPath = findExecutable("claude", process.env.PATH ?? "");
  if (onPath) dbg(`claude exe: on PATH = ${onPath}`);
  return onPath;
}

/**
 * Resolve the avatar process binary. Order:
 *   1. CLAUDE_EMOTE_AVATAR_EXE env var (test seam).
 *   2. <PROJECT_ROOT>/dist/host/avatar-process.js.
 */
function resolveAvatarExe(): string {
  return process.env.CLAUDE_EMOTE_AVATAR_EXE || AVATAR_PROCESS;
}

function pickPort(): Promise<number> {
  return new Promise((resolveReady) => {
    const srv: Server = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolveReady(port));
    });
  });
}

async function waitForHealth(url: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = new URL("/health", url).toString();
  while (Date.now() < deadline) {
    try {
      const ok = await new Promise<boolean>((resolveOne) => {
        const req = request(healthUrl, { method: "GET", timeout: 500 }, (res) => {
          res.resume();
          resolveOne(res.statusCode === 200);
        });
        req.on("error", () => resolveOne(false));
        req.on("timeout", () => {
          req.destroy();
          resolveOne(false);
        });
        req.end();
      });
      if (ok) return true;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Spawn the claude executable. Cross-platform: .js scripts route through
 * the current node binary; .cmd / .bat (Windows) route through cmd.exe;
 * everything else is spawned directly.
 */
function spawnClaude(
  exe: string,
  args: string[],
  opts: { stdio: import("node:child_process").StdioOptions; env?: NodeJS.ProcessEnv },
): ChildProcess {
  if (/\.(cmd|bat)$/i.test(exe) && process.platform === "win32") {
    return spawn("cmd.exe", ["/d", "/s", "/c", exe, ...args], {
      ...opts,
      windowsVerbatimArguments: false,
    });
  }
  if (/\.(js|mjs|cjs)$/i.test(exe)) {
    return spawn(process.execPath, [exe, ...args], opts);
  }
  return spawn(exe, args, opts);
}

async function main(): Promise<void> {
  const claudeArgs = process.argv.slice(2);

  if (isVersionArgv(claudeArgs)) {
    const claudeExe = resolveClaudeExe();
    if (!claudeExe) {
      console.error(
        "[claude-emote] ERROR: 'claude' not found on PATH. Install Claude Code first.",
      );
      process.exit(127);
    }
    dbg(`version probe: spawning ${claudeExe}`);
    const child = spawnClaude(claudeExe, claudeArgs, { stdio: "inherit" });
    child.on("close", (code) => process.exit(code ?? 0));
    return;
  }

  const claudeExe = resolveClaudeExe();
  if (!claudeExe) {
    console.error(
      "[claude-emote] ERROR: 'claude' not found on PATH. Install Claude Code first: https://docs.claude.com/claude-code",
    );
    process.exit(127);
  }

  const port = await pickPort();
  const instanceId = randomBytes(6).toString("hex");
  const endpoint = `http://127.0.0.1:${port}/event`;
  dbg(`port=${port} instance=${instanceId} endpoint=${endpoint}`);

  const avatarExe = resolveAvatarExe();
  dbg(`avatar exe: ${avatarExe}`);

  // Build the avatar child argv. Phase 6: only forward a custom emote
  // path when the user explicitly set CLAUDE_EMOTE_EMOTE_DIR. Otherwise
  // the avatar process picks its bundled default that matches the
  // resolved renderer kind.
  const userEmoteDir = process.env.CLAUDE_EMOTE_EMOTE_DIR?.trim() || null;
  const innerAvatarArgs = [
    avatarExe,
    `--port=${port}`,
    `--instance=${instanceId}`,
  ];
  if (userEmoteDir) {
    innerAvatarArgs.push(`--emoteDir=${userEmoteDir}`);
  }
  innerAvatarArgs.push(`--parentPid=${process.pid}`);

  // Phase 3 deliberately launches the avatar as a detached child on
  // non-Windows-Terminal hosts so the test does not depend on Windows
  // Terminal pane creation. Phase 8 will replace this with the proper
  // `wt -w 0 split-pane -V ...` invocation.
  let avatarProcess: ChildProcess | null = null;
  const testMode = process.env.CLAUDE_EMOTE_TEST_MODE === "1";
  if (testMode) {
    // Test seam: spawn the avatar directly with the current node binary,
    // attached to this process (no detached, no shell, no wt, no start,
    // no unref). The launcher retains the handle, kills it on shutdown,
    // and awaits its exit before process.exit()ing so test harnesses
    // never observe orphan fake-avatar processes or visible cmd windows.
    avatarProcess = spawn(process.execPath, innerAvatarArgs, {
      stdio: ["ignore", "inherit", "inherit"],
    });
  } else if (process.platform === "win32") {
    const cmd = `node ${innerAvatarArgs.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(" ")}`;
    const child = spawn(`start "" /B cmd /c ${cmd}`, {
      detached: true,
      stdio: "ignore",
      shell: true,
    });
    child.unref();
  } else {
    avatarProcess = spawn(process.execPath, innerAvatarArgs, {
      detached: true,
      stdio: "ignore",
    });
    avatarProcess.unref();
  }

  const health = await waitForHealth(endpoint);
  if (!health) {
    console.error(
      "[claude-emote] WARNING: avatar server did not respond to /health within 5s.",
    );
    console.error(
      "[claude-emote] Starting Claude anyway — the avatar will not appear, but Claude is unaffected.",
    );
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_EMOTE_INSTANCE_ID: instanceId,
    CLAUDE_EMOTE_ENDPOINT: endpoint,
    CLAUDE_EMOTE_PARENT_PID: String(process.pid),
  };

  const finalClaudeArgs = buildClaudeArgs(claudeArgs, PROJECT_ROOT);
  dbg(`claude argv: ${finalClaudeArgs.join(" ")}`);

  const child = spawnClaude(claudeExe, finalClaudeArgs, {
    stdio: "inherit",
    env: childEnv,
  });

  child.on("close", (code) => {
    dbg(`claude child closed with code ${code}`);
    dbg(`launcher exiting with code ${code ?? 0}`);
    // In test mode, await the avatar's actual exit so the test harness
    // never sees an orphan avatar process.
    if (testMode && avatarProcess && !avatarProcess.killed) {
      try { avatarProcess.kill("SIGTERM"); } catch {}
    }
    if (testMode && avatarProcess) {
      const p = avatarProcess;
      p.once("close", () => {
        process.exit(code ?? 0);
      });
      setTimeout(() => {
        try { p.kill("SIGKILL"); } catch {}
        process.exit(code ?? 0);
      }, 2000).unref();
    } else {
      if (avatarProcess && !avatarProcess.killed) {
        try { avatarProcess.kill("SIGTERM"); } catch {}
      }
      process.exit(code ?? 0);
    }
  });
  child.on("exit", (code) => {
    dbg(`claude child exit with code ${code}`);
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      try {
        child.kill(sig);
      } catch {}
      if (avatarProcess && !avatarProcess.killed) {
        try { avatarProcess.kill("SIGTERM"); } catch {}
      }
    });
  }
}

main();
