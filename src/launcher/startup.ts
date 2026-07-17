/**
 * startup.ts
 *
 * Import-safe helpers used by the claude-emote launcher to await
 * avatar-server readiness. Kept separate from claude-emote.ts so the
 * helpers can be exercised by unit tests without triggering the full
 * launcher orchestration (main()).
 *
 * Phase 8 corrected design:
 *
 *   The launcher conflated two different processes during Windows
 *   Terminal mode:
 *
 *     1. wtHostProcess: the short-lived wt.exe command process that
 *        creates the pane. It typically exits immediately after
 *        spawn.
 *     2. pane avatar:   the actual avatar process running inside the
 *        pane. It is NOT the ChildProcess returned by spawn().
 *
 *   In the original implementation the wt child was passed to a
 *   startup waiter that raced /health against child error / child
 *   exit. The "child exited" leg was correct when the child was the
 *   avatar, but wrong for the wt path: the wt process exits normally
 *   right after creating the pane, and that exit was being
 *   misinterpreted as "the avatar died before becoming healthy".
 *
 *   The fix is to split readiness waiting into two contracts:
 *
 *     - waitForOwnedAvatarStartup(child, endpoint, timeoutMs):
 *         The launcher OWNS this ChildProcess (test-mode or attached
 *         fallback). /health / child-error / child-exit / timeout are
 *         all valid signals.
 *
 *     - waitForEndpointHealth(endpoint, timeoutMs):
 *         Used for Windows Terminal mode. The launcher does NOT own
 *         the avatar ChildProcess — only the wt host. Readiness is
 *         observed solely through /health on the assigned port. The
 *         wt host's exit is irrelevant and must NOT be observed.
 *
 *   Production selection (in claude-emote.ts):
 *
 *     if (avatarSpawnedVia === "wt") {
 *       await waitForEndpointHealth(endpoint, timeoutMs);
 *     } else {
 *       await waitForOwnedAvatarStartup(
 *         ownedAvatarProcess,
 *         endpoint,
 *         timeoutMs,
 *       );
 *     }
 */

import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";

/**
 * Discriminated result for "can we start Claude yet?" decisions.
 *
 *   - `healthy`: /health responded 200 within the timeout.
 *   - `spawn-error`: the avatar ChildProcess emitted an `error` event.
 *   - `exited`: the avatar ChildProcess exited before becoming healthy.
 *   - `timeout`: the avatar is still alive but /health never succeeded.
 *
 * Used by the attached/test paths where the launcher owns the child.
 * The Windows Terminal path does NOT use this contract — see
 * waitForEndpointHealth() below.
 */
export type AvatarStartupResult =
  | { status: "healthy" }
  | { status: "spawn-error"; error: Error }
  | { status: "exited"; code: number | null; signal: NodeJS.Signals | null }
  | { status: "timeout" };

/**
 * Observe an owned avatar ChildProcess for its startup outcome.
 *
 * Four signals are raced:
 *
 *   - /health endpoint returns 200 → healthy
 *   - child emits `error`           → spawn-error
 *   - child emits `exit`            → exited
 *   - `healthTimeoutMs` elapses     → timeout
 *
 * Important: the child may already be exited before listeners are
 * attached (Node spawns synchronously, exit can race). We check
 * exitCode/signalCode before AND after listener registration.
 *
 * Listeners are removed exactly once. Timers are stored in nullable
 * variables so the `finish` closure never references a timer before
 * it has been initialized.
 *
 * The returned promise resolves exactly once.
 */
export function waitForOwnedAvatarStartup(
  child: ChildProcess,
  endpoint: string,
  healthTimeoutMs: number,
): Promise<AvatarStartupResult> {
  return new Promise<AvatarStartupResult>((resolveOne) => {
    let resolved = false;
    let pollTimer: NodeJS.Timeout | null = null;
    let deadlineTimer: NodeJS.Timeout | null = null;
    const finish = (result: AvatarStartupResult): void => {
      if (resolved) return;
      resolved = true;
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      if (pollTimer !== null) clearInterval(pollTimer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      resolveOne(result);
    };
    const onError = (err: Error): void =>
      finish({ status: "spawn-error", error: err });
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
      finish({ status: "exited", code, signal });

    // Pre-listener check: the child may have already exited.
    if (child.exitCode !== null || child.signalCode !== null) {
      finish({
        status: "exited",
        code: child.exitCode,
        signal: child.signalCode,
      });
      return;
    }

    child.once("error", onError);
    child.once("exit", onExit);

    // Post-listener check: race between checking and attaching.
    if (child.exitCode !== null || child.signalCode !== null) {
      finish({
        status: "exited",
        code: child.exitCode,
        signal: child.signalCode,
      });
      return;
    }

    const healthUrl = new URL("/health", endpoint).toString();
    const tryHealth = (): void => {
      const req = request(
        healthUrl,
        { method: "GET", timeout: 500 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) finish({ status: "healthy" });
        },
      );
      req.on("error", () => {
        /* swallow; we'll retry or timeout */
      });
      req.on("timeout", () => req.destroy());
      req.end();
    };
    tryHealth();
    pollTimer = setInterval(() => {
      if (!resolved) tryHealth();
    }, 100);

    deadlineTimer = setTimeout(
      () => finish({ status: "timeout" }),
      healthTimeoutMs,
    );
  });
}

/**
 * Observe a localhost HTTP endpoint for /health=200 within a timeout.
 *
 * Used for Windows Terminal mode, where the launcher does NOT own
 * the avatar ChildProcess. Only /health and timeout matter here.
 * The wt.exe pane-host process may exit (or error) immediately after
 * spawn — that is irrelevant and is not observed by this helper.
 *
 * Resolves true on /health=200, false on timeout.
 */
export function waitForEndpointHealth(
  endpoint: string,
  healthTimeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolveOne) => {
    let resolved = false;
    const finish = (ok: boolean): void => {
      if (resolved) return;
      resolved = true;
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      if (pollTimer !== null) clearInterval(pollTimer);
      resolveOne(ok);
    };
    const healthUrl = new URL("/health", endpoint).toString();
    const tryHealth = (): void => {
      if (resolved) return;
      const req = request(
        healthUrl,
        { method: "GET", timeout: 500 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) finish(true);
        },
      );
      req.on("error", () => {
        /* swallow; we'll retry or timeout */
      });
      req.on("timeout", () => req.destroy());
      req.end();
    };
    tryHealth();
    let pollTimer: NodeJS.Timeout | null = setInterval(() => {
      if (!resolved) tryHealth();
    }, 100);
    let deadlineTimer: NodeJS.Timeout | null = setTimeout(
      () => finish(false),
      healthTimeoutMs,
    );
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
export function waitForSpawnOutcome(
  child: ChildProcess,
  timeoutMs = 2_000,
): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolveOne) => {
    let resolved = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (outcome: SpawnOutcome): void => {
      if (resolved) return;
      resolved = true;
      if (timer !== null) clearTimeout(timer);
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
      resolveOne(outcome);
    };
    const onSpawn = (): void => finish({ ok: true });
    const onError = (err: Error): void => finish({ ok: false, error: err });
    timer = setTimeout(
      () => finish({ ok: false, error: new Error("spawn outcome timed out") }),
      timeoutMs,
    );
    child.once("spawn", onSpawn);
    child.once("error", onError);
    // The child may have already exited (e.g. very fast failure path).
    if (child.exitCode !== null || child.signalCode !== null) {
      finish({ ok: false, error: new Error("child exited before spawn observed") });
    }
  });
}

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
export async function terminateOwnedAvatar(
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
    let timer: NodeJS.Timeout | null = setTimeout(() => resolveOne(false), timeoutMs);
    child.once("exit", () => {
      if (timer !== null) clearTimeout(timer);
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
    let timer: NodeJS.Timeout | null = setTimeout(() => resolveOne(), 1_000);
    child.once("exit", () => {
      if (timer !== null) clearTimeout(timer);
      resolveOne();
    });
  });
}

/**
 * Spawn a long-running placeholder child process for tests. Public
 * export kept narrow so unit tests can construct owned-avatar
 * ChildProcess objects deterministically.
 */
export function spawnLongRunningChild(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
}
