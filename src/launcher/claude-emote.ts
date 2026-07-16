#!/usr/bin/env node
/**
 * claude-emote.ts
 *
 * The `claude-emote` launcher.
 *
 * Phase 8 production behavior (Windows + Windows Terminal):
 *   - Verify that the `claude` executable is reachable.
 *   - If argv contains --version / -v, spawn the version probe and
 *     return immediately. No port allocation, no avatar pane.
 *   - Otherwise:
 *       allocate a port
 *       build avatar argv (AVATAR_PROCESS + port + instance + parentPid
 *         + optional --emoteDir from CLAUDE_EMOTE_EMOTE_DIR)
 *       if running on a Windows host AND wt.exe is locatable:
 *           spawn wt.exe -w 0 split-pane -V --size 0.25 \
 *               -d <projectCwd> --title claude-emote \
 *               process.execPath avatarArgs
 *       else if not on Windows or wt.exe not found:
 *           spawn avatar as an attached child of the launcher
 *           (no detached, no shell, no start, no cmd)
 *       poll /health with a bounded timeout
 *       spawn real Claude in the original pane (with --plugin-dir +
 *         endpoint env)
 *       on Claude exit: launcher exits, avatar parent-pid watcher
 *         notices and shuts down
 *       forward Claude's exit code
 *
 * Test seams (kept narrow, named clearly so they're easy to spot in a
 * code review):
 *   - CLAUDE_EMOTE_CLAUDE_EXE   override the resolved claude executable
 *   - CLAUDE_EMOTE_AVATAR_EXE   override the avatar process binary
 *   - CLAUDE_EMOTE_WT_EXE       override the Windows Terminal executable
 *   - CLAUDE_EMOTE_TEST_MODE=1  bypass wt.exe; spawn avatar directly
 *                                (kept for tests/integration/launcher.test.ts)
 *   - CLAUDE_EMOTE_DRY_RUN=1    resolve all paths and print, exit zero
 *                                without starting any process
 *
 * No shell:true, no detached:true, no start, no cmd /c appear anywhere
 * in the production Windows path.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";

import {
  PROJECT_ROOT,
  AVATAR_PROCESS,
  isVersionArgv,
  buildClaudeArgs,
  buildAvatarArgv,
  buildWindowsTerminalArgs,
  findWindowsTerminalExecutable,
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

function effectivePlatform(): NodeJS.Platform {
  const override = process.env.CLAUDE_EMOTE_TEST_PLATFORM;
  if (
    override === "win32" ||
    override === "darwin" ||
    override === "linux"
  ) {
    return override;
  }
  return process.platform;
}

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
  const dryRun = process.env.CLAUDE_EMOTE_DRY_RUN === "1";

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

  const userEmoteDir = process.env.CLAUDE_EMOTE_EMOTE_DIR?.trim() || null;
  const avatarArgv = buildAvatarArgv({
    scriptPath: avatarExe,
    port,
    instanceId,
    emoteDir: userEmoteDir,
    parentPid: process.pid,
  });
  // avatarArgv[0] is the avatar script path. Decompose so the pane
  // builder receives (executable, [script, ...args]).
  const [avatarScript, ...avatarScriptArgs] = avatarArgv;
  const userCwd = process.cwd();

  const testMode = process.env.CLAUDE_EMOTE_TEST_MODE === "1";
  const platform = effectivePlatform();
  const wtExe = testMode
    ? null
    : (platform === "win32"
        ? findWindowsTerminalExecutable(process.env, platform)
        : null);

  if (dryRun) {
    const exe = wtExe ?? "(fallback: attached child)";
    const args = wtExe
      ? buildWindowsTerminalArgs({
          title: "claude-emote",
          workingDirectory: userCwd,
          executable: process.execPath,
          executableArgs: [avatarScript, ...avatarScriptArgs],
        })
      : [process.execPath, avatarScript, ...avatarScriptArgs];
    process.stderr.write(`[claude-emote] dry-run wt executable: ${exe}\n`);
    process.stderr.write(
      `[claude-emote] dry-run argv: ${JSON.stringify(args)}\n`,
    );
    process.exit(0);
    return;
  }

  // Avatar launch path.
  let avatarProcess: ChildProcess | null = null;
  let avatarSpawnedVia: "wt" | "attached" | "test" = "attached";

  if (testMode) {
    // Test seam: spawn the avatar directly with the current node
    // binary. Attached child, no detached, no shell, no wt, no start,
    // no cmd, no unref. The launcher retains the handle and cleans it
    // up at Claude exit.
    avatarProcess = spawn(
      process.execPath,
      [avatarScript, ...avatarScriptArgs],
      {
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    avatarSpawnedVia = "test";
  } else if (wtExe) {
    // Production Windows Terminal path: wt.exe spawns the avatar in a
    // right-side pane. spawn() returns the wt.exe child handle, which
    // exits quickly after pane creation. The avatar's parent-pid
    // watcher notices when the launcher exits and shuts down.
    const wtArgs = buildWindowsTerminalArgs({
      title: `claude-emote (${instanceId.slice(0, 6)})`,
      workingDirectory: userCwd,
      executable: process.execPath,
      executableArgs: [avatarScript, ...avatarScriptArgs],
    });
    dbg(`wt argv: ${JSON.stringify(wtArgs)}`);
    // If the resolved wt executable is a Node script (test seam only
    // — real wt.exe is always a real .exe on Windows), route it through
    // the current node binary. This keeps the production spawn() shape
    // ({ shell: false, detached: false, stdio: "ignore", windowsHide: true
    // }) intact for real users while letting tests use a script shim.
    const isNodeScript = /\.(cjs|js|mjs)$/i.test(wtExe);
    const spawnExe = isNodeScript ? process.execPath : wtExe;
    const spawnArgs = isNodeScript ? [wtExe, ...wtArgs] : wtArgs;
    avatarProcess = spawn(spawnExe, spawnArgs, {
      shell: false,
      detached: false,
      stdio: "ignore",
      windowsHide: true,
    });
    avatarSpawnedVia = "wt";
  } else {
    // Fallback outside Windows Terminal (or wt.exe not found):
    // spawn the avatar as an attached child of the launcher. This may
    // share the terminal output but must not open repeated CMD windows
    // or create orphans.
    console.error(
      "[claude-emote] NOTE: Windows Terminal (wt.exe) not found. " +
        "Spawning avatar as an attached child of the launcher.",
    );
    avatarProcess = spawn(
      process.execPath,
      [avatarScript, ...avatarScriptArgs],
      {
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    avatarSpawnedVia = "attached";
  }
  dbg(`avatar launch: ${avatarSpawnedVia}`);

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
      // For the wt.exe path and the attached fallback the avatar
      // already receives --parentPid=<launcher> and watches this
      // process. Exiting here will fire its parent-pid watcher at
      // the next 1s tick, then shutdown() at +500ms.
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
      if (testMode && avatarProcess && !avatarProcess.killed) {
        try { avatarProcess.kill("SIGTERM"); } catch {}
      }
    });
  }
}

main();