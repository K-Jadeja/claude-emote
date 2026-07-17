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

/**
 * Result of observing a spawned ChildProcess for its spawn outcome.
 *
 * - `ok=true` means the `spawn` event fired (the child has been started
 *   by the OS).
 * - `ok=false` means the `error` event fired (spawn failed). The
 *   original `Error` is preserved for logging.
 *
 * Resolution is exactly once. The `timeoutMs` watchdog covers the
 * pathological case where neither event arrives (extremely rare, but
 * we never want a promise that never resolves to leak Claude).
 */
export interface SpawnOutcome {
  ok: boolean;
  error?: Error;
}

/**
 * Observe a single ChildProcess's spawn outcome.
 *
 * Why this exists:
 *
 *   Node ChildProcess spawn failures can be delivered asynchronously
 *   through the `error` event after spawn() returns. Without an
 *   `error` listener, Node raises an unhandled error and crashes the
 *   launcher — which means a single bad wt.exe install (or a typo in
 *   CLAUDE_EMOTE_WT_EXE) takes down Claude.
 *
 *   This helper attaches exactly one `spawn` listener and one `error`
 *   listener, removes them on resolution, and resolves exactly once.
 */
function waitForSpawnOutcome(
  child: ChildProcess,
  timeoutMs = 2_000,
): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolveOne) => {
    let resolved = false;
    const finish = (outcome: SpawnOutcome): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
      resolveOne(outcome);
    };
    const onSpawn = (): void => finish({ ok: true });
    const onError = (err: Error): void => finish({ ok: false, error: err });
    const timer = setTimeout(() => finish({ ok: false, error: new Error("spawn outcome timed out") }), timeoutMs);
    child.once("spawn", onSpawn);
    child.once("error", onError);
    // The child may have already exited (e.g. very fast failure path).
    if (child.exitCode !== null || child.signalCode !== null) {
      finish({ ok: false, error: new Error("child exited before spawn observed") });
    }
  });
}

/**
 * Discriminated result for "can we start Claude yet?" decisions.
 *
 *   - `healthy`: /health responded 200 within the timeout.
 *   - `spawn-error`: the avatar ChildProcess emitted an `error` event.
 *   - `exited`: the avatar ChildProcess exited before becoming healthy.
 *   - `timeout`: the avatar is still alive but /health never succeeded.
 *
 * Used by both the attached-fallback path (where the launcher owns the
 * child) and the wt-pane path (where the wt handle is NOT the avatar;
 * only an avatar-server health timeout applies).
 */
export type AvatarStartupResult =
  | { status: "healthy" }
  | { status: "spawn-error"; error: Error }
  | { status: "exited"; code: number | null; signal: NodeJS.Signals | null }
  | { status: "timeout" };

/**
 * Combined readiness operation for an attached avatar ChildProcess.
 *
 * The four possible outcomes are raced:
 *
 *   - /health endpoint returns 200 → healthy
 *   - child emits `error`           → spawn-error
 *   - child emits `exit`            → exited
 *   - `healthTimeoutMs` elapses     → timeout
 *
 * Once any path resolves the result is final. Listeners are removed.
 * If the child exits/errs mid-flight, /health polling stops within
 * one polling tick (~100ms) — we never wait the full timeout after a
 * known failure.
 */
function waitForAvatarStartup(
  child: ChildProcess,
  endpoint: string,
  healthTimeoutMs: number,
): Promise<AvatarStartupResult> {
  return new Promise<AvatarStartupResult>((resolveOne) => {
    let resolved = false;
    const finish = (result: AvatarStartupResult): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(deadlineTimer);
      clearInterval(pollTimer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      resolveOne(result);
    };
    const onError = (err: Error): void =>
      finish({ status: "spawn-error", error: err });
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
      finish({ status: "exited", code, signal });

    child.once("error", onError);
    child.once("exit", onExit);

    // Poll /health. Resolves healthy on the first 200.
    const healthUrl = new URL("/health", endpoint).toString();
    const tryHealth = (): void => {
      const req = request(healthUrl, { method: "GET", timeout: 500 }, (res) => {
        res.resume();
        if (res.statusCode === 200) finish({ status: "healthy" });
      });
      req.on("error", () => { /* swallow; we'll retry or timeout */ });
      req.on("timeout", () => req.destroy());
      req.end();
    };
    // Kick once immediately, then on a 100ms tick until resolution.
    tryHealth();
    const pollTimer = setInterval(() => {
      if (!resolved) tryHealth();
    }, 100);

    const deadlineTimer = setTimeout(
      () => finish({ status: "timeout" }),
      healthTimeoutMs,
    );
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
    avatarProcess = spawnAttachedAvatar();
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
    const wtChild = spawn(spawnExe, spawnArgs, {
      shell: false,
      detached: false,
      stdio: "ignore",
      windowsHide: true,
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
      avatarProcess = spawnAttachedAvatar();
      avatarSpawnedVia = "attached";
    } else {
      avatarProcess = wtChild;
      avatarSpawnedVia = "wt";
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
    avatarProcess = spawnAttachedAvatar();
    avatarSpawnedVia = "attached";
  }
  dbg(`avatar launched via: ${avatarSpawnedVia}`);

  // Race-based startup waiter. Stops early when:
  //   - /health responds 200         → healthy
  //   - the avatar child emits error → spawn-error
  //   - the avatar child exits       → exited
  //   - the timeout elapses          → timeout
  //
  // For "wt" mode, the handle IS the wt process (not the avatar), so
  // the error/exit legs are not meaningful there — we only use the
  // health timeout. The wt process typically exits within ~100ms of
  // spawning the pane anyway, which we ignore.
  const healthTimeoutMs = (() => {
    const raw = process.env.CLAUDE_EMOTE_HEALTH_TIMEOUT_MS;
    if (!raw) return 5_000;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 5_000;
    return parsed;
  })();
  const startup = await waitForAvatarStartup(
    avatarProcess,
    endpoint,
    avatarSpawnedVia === "wt" ? healthTimeoutMs : healthTimeoutMs,
  );
  switch (startup.status) {
    case "healthy":
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
  // healthy, terminate it before Claude starts. The wt pane avatar
  // remains parent-watcher-owned; the wt process itself is gone by
  // now (it exits once the pane is created).
  if (
    avatarSpawnedVia !== "wt" &&
    startup.status !== "healthy" &&
    avatarProcess
  ) {
    await terminateOwnedAvatar(avatarProcess);
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
        await terminateOwnedAvatar(avatarProcess);
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