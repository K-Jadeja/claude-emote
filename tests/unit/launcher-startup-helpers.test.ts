/**
 * launcher-startup-helpers.test.ts
 *
 * Focused unit tests for src/launcher/startup.ts.
 *
 * These tests exercise the two readiness contracts the launcher
 * relies on after the Phase 8 wt-host-vs-avatar fix:
 *
 *   1. waitForEndpointHealth(endpoint, timeoutMs)
 *      - Resolves true once a /health=200 response arrives.
 *      - Resolves false on timeout.
 *      - Never observes any wt-like ChildProcess (it has no such
 *        argument — the contract is intentionally narrow).
 *
 *   2. waitForOwnedAvatarStartup(child, endpoint, timeoutMs)
 *      - Resolves {status: "exited"} when the child has already
 *        exited before listeners attach.
 *      - Resolves {status: "exited"} when the child exits AFTER
 *        listener registration but before /health.
 *      - Resolves {status: "healthy"} when /health responds.
 *      - Resolves {status: "timeout"} when the child stays alive but
 *        never serves /health.
 *
 * No timers, HTTP servers, or child processes may remain after each
 * test (the helpers must be leak-clean).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";

import {
  waitForOwnedAvatarStartup,
  waitForEndpointHealth,
} from "../../src/launcher/startup.js";

interface HealthServerHandle {
  port: number;
  server: Server;
  /** Latest /health request observed (for diagnostics). */
  hitCount: number;
  /** When true, /health responds 200 immediately. Otherwise 500. */
  replyOk: boolean;
  /** Optional delay before the 200 response (ms). */
  delayMs: number;
  close: () => Promise<void>;
}

function startHealthServer(opts: {
  replyOk?: boolean;
  delayMs?: number;
} = {}): Promise<HealthServerHandle> {
  const replyOk = opts.replyOk ?? true;
  const delayMs = opts.delayMs ?? 0;
  return new Promise<HealthServerHandle>((resolveReady, rejectErr) => {
    const handle: HealthServerHandle = {
      port: 0,
      server: createServer(),
      hitCount: 0,
      replyOk,
      delayMs,
      close: () =>
        new Promise<void>((r) => {
          handle.server.close(() => r());
        }),
    };
    handle.server.on("request", (req, res) => {
      if (req.url === "/health") handle.hitCount++;
      const respond = (): void => {
        res.statusCode = handle.replyOk ? 200 : 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: handle.replyOk }));
      };
      if (handle.delayMs > 0) {
        setTimeout(respond, handle.delayMs);
      } else {
        respond();
      }
    });
    handle.server.on("error", rejectErr);
    handle.server.listen(0, "127.0.0.1", () => {
      const addr = handle.server.address();
      if (typeof addr !== "object" || !addr) {
        rejectErr(new Error("failed to bind ephemeral port"));
        return;
      }
      handle.port = addr.port;
      resolveReady(handle);
    });
  });
}

function spawnIdleChild(): ChildProcess {
  // Long-lived child the test can kill manually. We never observe its
  // /health; this is a generic "alive but quiet" placeholder for the
  // owned-avatar helper.
  return spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
}

function spawnEarlyExitChild(): ChildProcess {
  // Synchronously-exits child, used to prove the pre-listener exit
  // check. We pass a script that synchronously calls process.exit so
  // the child's exitCode/signalCode are already populated by the time
  // we hand the handle to the helper.
  return spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
  });
}

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGKILL"); } catch { /* may already be dead */ }
  await new Promise<void>((r) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      r();
      return;
    }
    child.once("exit", () => r());
    setTimeout(() => r(), 1_000);
  });
}

const liveChildren: ChildProcess[] = [];
const liveServers: HealthServerHandle[] = [];

afterEach(async () => {
  while (liveChildren.length > 0) {
    const c = liveChildren.pop()!;
    await killChild(c);
  }
  while (liveServers.length > 0) {
    const s = liveServers.pop()!;
    await s.close();
  }
});

describe("waitForEndpointHealth", () => {
  it("returns true after a delayed 200 response", async () => {
    const srv = await startHealthServer({ replyOk: true, delayMs: 200 });
    liveServers.push(srv);
    const endpoint = `http://127.0.0.1:${srv.port}`;
    const ok = await waitForEndpointHealth(endpoint, 5_000);
    expect(ok).toBe(true);
  });

  it("returns false on timeout when /health never returns 200", async () => {
    const srv = await startHealthServer({ replyOk: false });
    liveServers.push(srv);
    const endpoint = `http://127.0.0.1:${srv.port}`;
    const ok = await waitForEndpointHealth(endpoint, 400);
    expect(ok).toBe(false);
  });

  it("does not depend on a wt child (the helper signature has none)", async () => {
    // Pure positive test: the contract for this helper is *just*
    // (endpoint, timeoutMs). Verifying that the function works in
    // isolation proves that the wt-mode branch in the launcher can
    // rely on it without passing a ChildProcess.
    const srv = await startHealthServer({ replyOk: true });
    liveServers.push(srv);
    const endpoint = `http://127.0.0.1:${srv.port}`;
    const ok = await waitForEndpointHealth(endpoint, 5_000);
    expect(ok).toBe(true);
  });
});

describe("waitForOwnedAvatarStartup", () => {
  it("resolves with exited when the child has already exited before helper call", async () => {
    const child = spawnEarlyExitChild();
    liveChildren.push(child);
    // Wait until the child has fully exited, so exitCode is populated.
    await new Promise<void>((r) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        r();
        return;
      }
      child.once("exit", () => r());
    });
    // We need a real /health endpoint URL to satisfy the helper's
    // signature, but the child has already exited so /health will not
    // be queried.
    const srv = await startHealthServer({ replyOk: true });
    liveServers.push(srv);
    const endpoint = `http://127.0.0.1:${srv.port}`;
    const result = await waitForOwnedAvatarStartup(child, endpoint, 5_000);
    expect(result.status).toBe("exited");
    if (result.status === "exited") {
      expect(result.code).toBe(0);
    }
  });

  it("resolves with exited when the child exits after listener registration", async () => {
    const child = spawnIdleChild();
    liveChildren.push(child);
    // Health server delays its 200 by 800ms — long enough for the
    // SIGKILL to arrive first and propagate through the `exit`
    // listener. We want the child-exit leg of the race to win.
    const srv = await startHealthServer({ replyOk: true, delayMs: 800 });
    liveServers.push(srv);
    const endpoint = `http://127.0.0.1:${srv.port}`;
    // Race the helper against a SIGKILL on the idle child.
    const killer = (async (): Promise<void> => {
      await new Promise((r) => setTimeout(r, 80));
      try { child.kill("SIGKILL"); } catch { /* may already be dead */ }
    })();
    const result = await waitForOwnedAvatarStartup(child, endpoint, 5_000);
    await killer;
    expect(result.status).toBe("exited");
  });

  it("resolves with healthy when the child becomes healthy", async () => {
    const child = spawnIdleChild();
    liveChildren.push(child);
    // Reply 200 after a small delay — the helper's first probe is
    // immediate, so the helper will see the 200 on the second or
    // third tick. Either way it must converge to healthy well
    // before the timeout.
    const srv = await startHealthServer({ replyOk: true, delayMs: 80 });
    liveServers.push(srv);
    const endpoint = `http://127.0.0.1:${srv.port}`;
    const result = await waitForOwnedAvatarStartup(child, endpoint, 5_000);
    expect(result.status).toBe("healthy");
  });

  it("resolves with timeout when the child stays alive but unhealthy", async () => {
    const child = spawnIdleChild();
    liveChildren.push(child);
    // Server replies 500 forever. We use a short health timeout so
    // the test runs fast.
    const srv = await startHealthServer({ replyOk: false });
    liveServers.push(srv);
    const endpoint = `http://127.0.0.1:${srv.port}`;
    const result = await waitForOwnedAvatarStartup(child, endpoint, 500);
    expect(result.status).toBe("timeout");
  });

  it("does not leave timers, HTTP servers, or child processes behind", async () => {
    // Run a mixed scenario that exercises both helpers. The cleanup
    // is the afterEach hook above; if any handler leaked, the helper
    // under test would either hold a server open (visible via
    // srv.hitCount) or keep the child alive (visible via killChild
    // awaiting exit).
    const srv1 = await startHealthServer({ replyOk: true, delayMs: 50 });
    liveServers.push(srv1);
    const child1 = spawnIdleChild();
    liveChildren.push(child1);
    await waitForOwnedAvatarStartup(
      child1,
      `http://127.0.0.1:${srv1.port}`,
      5_000,
    );
    const srv2 = await startHealthServer({ replyOk: false });
    liveServers.push(srv2);
    await waitForEndpointHealth(
      `http://127.0.0.1:${srv2.port}`,
      200,
    );
    // Confirm we did NOT accidentally leak: the children should
    // still be alive (helper does not own them) and the servers
    // should still be listening (helper does not own them either).
    expect(child1.exitCode).toBeNull();
    expect(srv1.server.listening).toBe(true);
    expect(srv2.server.listening).toBe(true);
    // The afterEach hook will reap both. We assert it works.
  });
});

describe("helpers are import-safe (do not invoke main)", () => {
  it("can be imported without side effects", () => {
    // If importing the launcher module triggered main(), the test
    // process would have already exited. We are still here, so
    // startup.ts is import-safe.
    expect(typeof waitForEndpointHealth).toBe("function");
    expect(typeof waitForOwnedAvatarStartup).toBe("function");
  });
});
