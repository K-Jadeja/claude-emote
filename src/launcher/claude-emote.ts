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
import {
  waitForOwnedAvatarStartup,
  waitForEndpointHealth,
  waitForSpawnOutcome,
  terminateOwnedAvatar,
} from "./startup.js";

export type { SpawnOutcome } from "./startup.js";
export type { AvatarStartupResult } from "./startup.js";

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

  // Avatar launch path. Ownership truthfulness:
  //
  //   - ownedAvatarProcess is the ChildProcess we own directly and
  //     may terminate on Claude exit. It is the actual avatar for
  //     "test" and "attached" modes, and null for "wt" mode.
  //   - wtHostProcess is the ChildProcess returned by the wt.exe
  //     spawn, kept only for diagnostics. It is NOT the avatar and
  //     must never be terminated as though it were one. The wt
  //     process typically exits immediately after creating the pane.
  //   - avatarSpawnedVia describes how the avatar was launched and
  //     therefore who owns the cleanup:
  //       * "test":     launcher owns ownedAvatarProcess.
  //       * "attached": launcher owns ownedAvatarProcess.
  //       * "wt":       launcher owns NOTHING — ownedAvatarProcess is
  //                     null. The avatar is reaped via its own
  //                     --parentPid=<launcherPid> watcher (Phase 4).
  let ownedAvatarProcess: ChildProcess | null = null;
  let wtHostProcess: ChildProcess | null = null;
  let avatarSpawnedVia: "test" | "attached" | "wt" = "attached";

  /**
   * Spawn the avatar as a directly-attached child. Used in two cases:
   * (a) the WT branch fell back here because wt.exe failed to spawn,
   * (b) we're outside Windows Terminal / wt.exe is missing / non-Windows.
   *
   * Production shape: shell:false, detached:false, no start, no cmd,
   * no unref. The handle is owned by the launcher.
   */
  const spawnAttachedAvatar = (): ChildProcess => {
    return spawn(
      process.execPath,
      [avatarScript, ...avatarScriptArgs],
      {
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
  };

  if (testMode) {
    // Test seam: spawn the avatar directly with the current node
    // binary. Attached child, no detached, no shell, no wt, no start,
    // no cmd, no unref. The launcher retains the handle and cleans it
    // up at Claude exit.
    ownedAvatarProcess = spawnAttachedAvatar();
    avatarSpawnedVia = "test";
  } else if (decision.kind === "windows-terminal" && candidateWtExe) {
    // Inside Windows Terminal + wt.exe resolves: spawn wt.exe -w 0
    // split-pane ... so the avatar runs inside a Windows Terminal
    // pane. The spawned handle is wt.exe (which exits immediately
    // after pane creation). The launcher does NOT own the avatar —
    // ownedAvatarProcess stays null and cleanup is via the avatar's
    // --parentPid watcher.
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
    // Phase 10.1 visual-pane contract: the WT pane child receives
    // CLAUDE_EMOTE_VISUAL_PANE=1 so its writing surface is treated
    // as an exclusive render area (no READY, no fallback warning,
    // no debug logs, no installed-package paths in the pane).
    // Readiness is observed through /health instead. This env is
    // NOT added to the Claude child's environment below; it is
    // strictly scoped to the WT pane spawn.
    const wtSpawnEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDE_EMOTE_VISUAL_PANE: "1",
    };
    const wtChild = spawn(spawnExe, spawnArgs, {
      shell: false,
      detached: false,
      stdio: "ignore",
      windowsHide: true,
      env: wtSpawnEnv,
    });

    // Observe the wt spawn outcome asynchronously so a wt-side spawn
    // failure (EACCES, EINVAL, ENOENT inside Node's spawn path) does
    // not crash the launcher. On error we fall back to an attached
    // avatar and proceed.
    const wtOutcome = await waitForSpawnOutcome(wtChild, 2_000);
    if (!wtOutcome.ok) {
      const reason = (wtOutcome.error && wtOutcome.error.message) || "unknown";
      console.error(
        `[claude-emote] Windows Terminal launch failed: ${reason}; ` +
          `using attached avatar fallback.`,
      );
      // The failed wt handle must NOT be stored as the avatar — it is
      // not the avatar. Detach our reference and try directly.
      // The fallback owns a real attached avatar.
      ownedAvatarProcess = spawnAttachedAvatar();
      avatarSpawnedVia = "attached";
    } else {
      // wt spawn OK. The handle we have is the wt pane host, NOT
      // the avatar. Store it as wtHostProcess only; ownedAvatarProcess
      // stays null because we do not own the avatar PID. A harmless
      // diagnostic error listener keeps a later wt error from being
      // unhandled — we intentionally do NOT treat it as avatar exit.
      wtHostProcess = wtChild;
      ownedAvatarProcess = null;
      avatarSpawnedVia = "wt";
      wtHostProcess.on("error", (err) => {
        dbg(`wt host process error (ignored, not the avatar): ${err.message}`);
      });
    }
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
    ownedAvatarProcess = spawnAttachedAvatar();
    avatarSpawnedVia = "attached";
  }
  dbg(`avatar launched via: ${avatarSpawnedVia}`);

  // Startup waiter selection:
  //
  //   - "wt": the launcher does NOT own the avatar ChildProcess — it
  //     only owns the wt pane host, which may have already exited.
  //     Readiness is observed ONLY through /health. The wt process's
  //     own exit/error events are intentionally ignored.
  //   - "test"/"attached": the launcher owns the avatar ChildProcess,
  //     so /health / child-error / child-exit / timeout are all valid
  //     readiness signals.
  const healthTimeoutMs = (() => {
    const raw = process.env.CLAUDE_EMOTE_HEALTH_TIMEOUT_MS;
    if (!raw) return 5_000;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 5_000;
    return parsed;
  })();
  let startupHealthy = false;
  if (avatarSpawnedVia === "wt") {
    // Endpoint-only readiness: we never observe wtHostProcess.
    startupHealthy = await waitForEndpointHealth(endpoint, healthTimeoutMs);
    if (!startupHealthy) {
      console.error(
        `[claude-emote] WARNING: avatar server did not respond to /health within ${healthTimeoutMs}ms.`,
      );
      console.error(
        "[claude-emote] Starting Claude anyway — the avatar will not appear, but Claude is unaffected.",
      );
    } else {
      dbg("avatar /health responded (wt mode)");
    }
  } else {
    // Owned avatar: race /health / child-error / child-exit / timeout.
    // In all non-wt branches we assigned ownedAvatarProcess above
    // (test, attached, and the wt-fallback-to-attached branch). The
    // assertion documents this invariant for future readers.
    if (!ownedAvatarProcess) {
      throw new Error(
        "internal: ownedAvatarProcess must be set in non-wt mode",
      );
    }
    const startup = await waitForOwnedAvatarStartup(
      ownedAvatarProcess,
      endpoint,
      healthTimeoutMs,
    );
    switch (startup.status) {
      case "healthy":
        startupHealthy = true;
        dbg("avatar /health responded");
        break;
      case "spawn-error":
        console.error(
          `[claude-emote] WARNING: avatar spawn failed: ${startup.error.message}. ` +
            `Starting Claude anyway — no avatar will appear.`,
        );
        break;
      case "exited":
        console.error(
          `[claude-emote] WARNING: avatar exited before becoming healthy ` +
            `(code=${startup.code}, signal=${startup.signal ?? "none"}). ` +
            `Starting Claude anyway — no avatar will appear.`,
        );
        break;
      case "timeout":
        console.error(
          `[claude-emote] WARNING: avatar server did not respond to /health within ${healthTimeoutMs}ms.`,
        );
        console.error(
          "[claude-emote] Starting Claude anyway — the avatar will not appear, but Claude is unaffected.",
        );
        break;
    }

    // If we own the avatar and it's still alive but never became
    // healthy, terminate it before Claude starts.
    if (!startupHealthy && ownedAvatarProcess) {
      await terminateOwnedAvatar(ownedAvatarProcess);
    }
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_EMOTE_INSTANCE_ID: instanceId,
    CLAUDE_EMOTE_ENDPOINT: endpoint,
    CLAUDE_EMOTE_PARENT_PID: String(process.pid),
  };
  // Phase 10.1: the visual-pane flag is strictly scoped to the WT
  // pane child. Strip it from Claude's environment even if the
  // caller had it set globally, so Claude (and its hooks) never
  // observe a value meant only for the avatar pane.
  delete childEnv.CLAUDE_EMOTE_VISUAL_PANE;

  const finalClaudeArgs = buildClaudeArgs(claudeArgs, PROJECT_ROOT);
  dbg(`claude argv: ${finalClaudeArgs.join(" ")}`);

  const child = spawnClaude(claudeExe, finalClaudeArgs, {
    stdio: "inherit",
    env: childEnv,
  });

  child.on("close", (code) => {
    dbg(`claude child closed with code ${code}`);
    const finalCode = code ?? 0;
    void finalizeLauncher(finalCode, "claude-close");
  });
  child.on("exit", (code) => {
    dbg(`claude child exit with code ${code}`);
  });
  // If Claude's spawn fails asynchronously (rare — existence was
  // already verified, but ENOENT can still race with PATH lookup),
  // route it through the same finalizer so the launcher exits cleanly
  // with exit 1 instead of crashing on an unhandled `error`.
  child.on("error", (err) => {
    console.error(`[claude-emote] WARNING: claude child error: ${err.message}`);
    void finalizeLauncher(1, "claude-error");
  });

  /**
   * One idempotent finalizer.
   *
   *   - First call owns finalization (creates the cached promise).
   *   - Subsequent calls return the same promise; nothing runs twice.
   *   - The owned attached/test avatar is cleaned at most once.
   *   - process.exit() is called in exactly one place.
   *
   * The `kind` parameter lets us tell which closure fired first when
   * a signal races with Claude's close. Useful for logs and for the
   * SIGTERM/SIGINT-vs-Claude-close race test.
   */
  let finalizePromise: Promise<void> | null = null;
  function finalizeLauncher(exitCode: number, kind: string): Promise<void> {
    if (finalizePromise) return finalizePromise;
    finalizePromise = (async () => {
      dbg(`finalize start (${kind}, exitCode=${exitCode})`);
      // Cleanup the avatar ONLY when we own its ChildProcess handle.
      // The wt.exe pane path does NOT — the spawned handle is wt, not
      // the avatar, and the avatar's --parentPid watcher reaps the
      // avatar when this process exits (~1.5s after Claude closes).
      if (avatarSpawnedVia !== "wt") {
        await terminateOwnedAvatar(ownedAvatarProcess);
      }
      process.exit(exitCode);
    })();
    return finalizePromise;
  }

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      dbg(`signal received: ${sig}`);
      try {
        child.kill(sig);
      } catch {}
      // Signal semantics:
      //   SIGINT  → exit 130
      //   SIGTERM → exit 143
      const exitCode = sig === "SIGINT" ? 130 : 143;
      void finalizeLauncher(exitCode, `signal:${sig}`);
    });
  }

  /**
   * Test-only stdin hook.
   *
   *   On Windows, Node does not reliably deliver `process.on("SIGTERM")`
   *   when a parent process kills us via `process.kill(pid, "SIGTERM")`
   *   (Node uses `TerminateProcess` which does not surface to Node's
   *   signal handlers). For automated tests that need to exercise the
   *   SIGINT/SIGTERM finalize-once semantics deterministically, we
   *   expose `CLAUDE_EMOTE_TEST_FORCE_SIGNAL`: when set to `SIGINT` or
   *   `SIGTERM`, an EOF on the launcher's stdin triggers the matching
   *   signal handler. The production process inherits stdio, so for
   *   normal users this env is never set and the hook is a no-op.
   */
  const forceSignal = process.env.CLAUDE_EMOTE_TEST_FORCE_SIGNAL;
  if (forceSignal === "SIGINT" || forceSignal === "SIGTERM") {
    // Resume stdin so 'end' fires when the parent closes the pipe.
    // Without this, process.stdin sits in paused mode and never emits.
    process.stdin?.resume();
    process.stdin?.on("end", () => {
      dbg(`stdin end → firing ${forceSignal} handler (test seam)`);
      const exitCode = forceSignal === "SIGINT" ? 130 : 143;
      try {
        child.kill(forceSignal);
      } catch {}
      void finalizeLauncher(exitCode, `stdin:${forceSignal}`);
    });
  }
}

main();