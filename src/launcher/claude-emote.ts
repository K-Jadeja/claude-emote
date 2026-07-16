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
 *
 * Cleanup ownership:
 *   - "test" avatar:    launcher owns the ChildProcess. Explicit
 *                        terminate + await on Claude exit (see
 *                        terminateOwnedAvatar()).
 *   - "attached" avatar: launcher owns the ChildProcess. Explicit
 *                        terminate + await on Claude exit.
 *   - "wt" avatar:       launcher does NOT own the avatar. The wt
 *                        process returned by spawn() is the
 *                        Windows Terminal pane host, not the
 *                        avatar. The avatar runs inside the pane
 *                        under its own process. Cleanup on Claude
 *                        exit relies on the avatar's existing
 *                        --parentPid=<launcherPid> watcher
 *                        (Phase 4 contract).
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
  decideAvatarLaunchMode,
  findWindowsTerminalExecutable,
} from "./args.js";

/**
 * Best-effort, idempotent shutdown of a directly-spawned avatar
 * ChildProcess. Used for the test-mode path and the attached
 * fallback path. NOT used for the wt.exe pane path — the wt
 * spawn() returned a ChildProcess for the pane host, not the
 * avatar, so the launcher never held the avatar PID there.
 *
 * Steps:
 *   1. If the handle is null or already exited, do nothing.
 *   2. Send SIGTERM.
 *   3. Wait for `exit` (or `close`) up to `timeoutMs`.
 *   4. If the child is still alive, send SIGKILL.
 *   5. Wait for the final `exit` (or `close`) up to a small grace
 *      window.
 *
 * Repeated calls are safe — step 1 short-circuits.
 *
 * Does NOT call process.exit(); the caller forwards Claude's exit
 * code after this returns.
 */
async function terminateOwnedAvatar(
  child: ChildProcess | null,
  timeoutMs = 2_000,
): Promise<void> {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const tryKill = (sig: NodeJS.Signals): void => {
    try { child.kill(sig); } catch { /* already dead */ }
  };
  tryKill("SIGTERM");
  const exited = await new Promise<boolean>((resolveOne) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveOne(true);
      return;
    }
    const timer = setTimeout(() => resolveOne(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveOne(true);
    });
  });
  if (exited) return;
  tryKill("SIGKILL");
  await new Promise<void>((resolveOne) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveOne();
      return;
    }
    const timer = setTimeout(() => resolveOne(), 1_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveOne();
    });
  });
}

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

  // Resolve wt.exe lazily for the launch decision (test mode never
  // looks it up). On non-Windows we still call the resolver so the
  // dry-run path can report whether wt was found.
  const candidateWtExe = testMode
    ? null
    : findWindowsTerminalExecutable(process.env, platform);

  const decision = decideAvatarLaunchMode(
    process.env,
    platform,
    candidateWtExe,
  );
  dbg(`avatar launch decision: ${decision.kind} (${decision.reason})`);

  if (dryRun) {
    if (decision.kind === "windows-terminal") {
      const args = buildWindowsTerminalArgs({
        title: "claude-emote",
        workingDirectory: userCwd,
        executable: process.execPath,
        executableArgs: [avatarScript, ...avatarScriptArgs],
      });
      process.stderr.write(
        `[claude-emote] dry-run wt executable: ${candidateWtExe}\n`,
      );
      process.stderr.write(
        `[claude-emote] dry-run argv: ${JSON.stringify(args)}\n`,
      );
    } else {
      process.stderr.write(
        `[claude-emote] dry-run: ${decision.reason} — falling back to attached child, no pane\n`,
      );
      process.stderr.write(
        `[claude-emote] dry-run argv: ${JSON.stringify([
          process.execPath,
          avatarScript,
          ...avatarScriptArgs,
        ])}\n`,
      );
    }
    process.exit(0);
    return;
  }

  // Avatar launch path. avatarSpawnedVia describes ownership:
  //   - "test":     launcher owns the ChildProcess, explicit cleanup.
  //   - "attached": launcher owns the ChildProcess, explicit cleanup.
  //   - "wt":       launcher does NOT own the avatar PID. The
  //                 returned spawn() handle is the wt.exe pane
  //                 host, not the avatar. Cleanup on Claude exit
  //                 relies on the avatar's existing
  //                 --parentPid=<launcherPid> watcher.
  let avatarProcess: ChildProcess | null = null;
  let avatarSpawnedVia: "test" | "attached" | "wt" = "attached";

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
  } else if (decision.kind === "windows-terminal" && candidateWtExe) {
    // Inside Windows Terminal + wt.exe resolves: spawn wt.exe -w 0
    // split-pane ... so the avatar runs inside a Windows Terminal
    // pane. The spawned handle is wt.exe (which exits immediately
    // after pane creation); we store it only for diagnostics — cleanup
    // goes through the avatar's parent-pid watcher.
    const wtArgs = buildWindowsTerminalArgs({
      title: `claude-emote (${instanceId.slice(0, 6)})`,
      workingDirectory: userCwd,
      executable: process.execPath,
      executableArgs: [avatarScript, ...avatarScriptArgs],
    });
    dbg(`wt argv: ${JSON.stringify(wtArgs)}`);
    // If the resolved wt executable is a Node script (test seam only
    // — real wt.exe is always a real .exe on Windows), route it
    // through the current node binary. This keeps the production
    // spawn() shape ({ shell: false, detached: false, stdio:
    // "ignore", windowsHide: true }) intact for real users while
    // letting tests use a script shim.
    const isNodeScript = /\.(cjs|js|mjs)$/i.test(candidateWtExe);
    const spawnExe = isNodeScript ? process.execPath : candidateWtExe;
    const spawnArgs = isNodeScript
      ? [candidateWtExe, ...wtArgs]
      : wtArgs;
    avatarProcess = spawn(spawnExe, spawnArgs, {
      shell: false,
      detached: false,
      stdio: "ignore",
      windowsHide: true,
    });
    avatarSpawnedVia = "wt";
  } else {
    // Outside Windows Terminal OR wt.exe not found OR not on
    // Windows: launch as an attached child of the launcher. The
    // launcher owns this handle and explicitly cleans it up on
    // Claude exit via terminateOwnedAvatar().
    if (decision.reason !== "not-windows") {
      // Only print the warning when the user *could* have been in a
      // WT pane — pure-POSIX hosts aren't expected to provide wt.
      console.error(
        `[claude-emote] NOTE: not running inside Windows Terminal ` +
          `(${decision.reason}); spawning avatar as an attached child.`,
      );
    }
    avatarProcess = spawn(
      process.execPath,
      [avatarScript, ...avatarScriptArgs],
      {
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    avatarSpawnedVia = "attached";
  }
  dbg(`avatar launched via: ${avatarSpawnedVia}`);

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

  child.on("close", async (code) => {
    dbg(`claude child closed with code ${code}`);
    const finalCode = code ?? 0;
    // Cleanup the avatar ONLY when we own its ChildProcess handle.
    // The wt.exe pane path does NOT — the spawned handle is wt, not
    // the avatar, and the avatar's --parentPid watcher reaps the
    // avatar when this process exits (~1.5s after Claude closes).
    if (avatarSpawnedVia !== "wt") {
      await terminateOwnedAvatar(avatarProcess);
    }
    process.exit(finalCode);
  });
  child.on("exit", (code) => {
    dbg(`claude child exit with code ${code}`);
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      try {
        child.kill(sig);
      } catch {}
      // Forward the signal to the Claude child already happened
      // above. Now also forward to a directly-owned avatar (test
      // mode or attached fallback) — the wt pane path relies on the
      // parent-pid watcher, not on us killing the avatar here.
      if (avatarSpawnedVia !== "wt") {
        await terminateOwnedAvatar(avatarProcess);
      }
      process.exit(0);
    });
  }
}

main();