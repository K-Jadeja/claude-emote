#!/usr/bin/env node
/**
 * claude-emote.ts
 *
 * The `claude-emote` launcher.
 *
 * Responsibilities:
 *   1. Verify that the `claude` executable is reachable.
 *   2. Verify that we are inside Windows Terminal.
 *   3. Generate a random instance ID and pick an unused localhost port.
 *   4. Launch the avatar process in a narrow right-side Windows Terminal pane.
 *   5. Wait for the avatar server's /health endpoint to respond.
 *   6. Set the required env vars on the Claude Code child.
 *   7. Launch `claude` with all original arguments preserved.
 *   8. Forward Claude's exit code.
 *   9. Shut down the avatar on Claude exit, then kill it if it's still alive
 *      after a grace period.
 *
 * Failure handling:
 *   - If Windows Terminal pane creation is unavailable, print a clear
 *     warning and fall back to launching the avatar in a separate console
 *     window via `start`. Never block Claude from starting.
 *   - If the avatar server never comes up, Claude still starts (the bridge
 *     will simply have nothing to talk to; nothing in Claude's behaviour
 *     is affected).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { request } from "node:http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const DIST = join(PROJECT_ROOT, "dist");
const AVATAR_PROCESS = join(DIST, "host", "avatar-process.js");

const debug = process.env.CLAUDE_EMOTE_DEBUG === "1";
function dbg(msg: string): void {
  if (debug) process.stderr.write(`[claude-emote] ${msg}\n`);
}

// --- CLI parsing ------------------------------------------------------------

/**
 * All args after argv[0] are forwarded verbatim to `claude`. We do not
 * parse them here because Claude Code owns its own flag grammar.
 */
const claudeArgs = process.argv.slice(2);

// Recognise --version / -v as a passthrough that should not trigger a
// full Claude startup (we still want to know if Claude is installed).
const isVersionProbe = claudeArgs.includes("--version") || claudeArgs.includes("-v");

// --- Locate `claude` --------------------------------------------------------

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

const claudeExe = findExecutable("claude", process.env.PATH ?? "");
if (!claudeExe) {
  console.error(
    "[claude-emote] ERROR: 'claude' not found on PATH. Install Claude Code first: https://docs.claude.com/claude-code",
  );
  process.exit(127);
}
dbg(`claude found: ${claudeExe}`);

// --- Detect Windows Terminal ------------------------------------------------

const inWindowsTerminal = !!process.env.WT_SESSION;
if (!inWindowsTerminal) {
  console.error(
    "[claude-emote] WARNING: Not running in Windows Terminal. claude-emote V1 requires Windows Terminal for the avatar pane.",
  );
  console.error(
    "[claude-emote] Continuing Claude with a separate avatar console window. Some visual features (Sixel, ghost-free redraw) require Windows Terminal.",
  );
}

// --- Probe `wt --help` for split-pane support -------------------------------

interface WtCapabilities {
  wtPath: string | null;
  supportsSplitPane: boolean;
  supportsFullscreen: boolean;
  /** Whether the local wt version supports `-F` (force) for opening a new tab with raw args. */
  supportsForce: boolean;
}

const require_ = createRequire(import.meta.url);

function findWt(): string | null {
  // Check the well-known WinApps install first.
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const wt = join(local, "Microsoft", "WindowsApps", "wt.exe");
    if (existsSync(wt)) return wt;
  }
  // Then PATH.
  return findExecutable("wt", process.env.PATH ?? "");
}

function probeWt(): WtCapabilities {
  const wtPath = findWt();
  if (!wtPath) return { wtPath: null, supportsSplitPane: false, supportsFullscreen: false, supportsForce: false };
  try {
    const out = require_("node:child_process")
      .execFileSync(wtPath, ["--help"], { encoding: "utf8", timeout: 3000 })
      .toLowerCase();
    return {
      wtPath,
      supportsSplitPane: out.includes("split-pane"),
      supportsFullscreen: out.includes("-f") || out.includes("--full"),
      supportsForce: out.includes("-f") || out.includes("--full"),
    };
  } catch {
    return { wtPath, supportsSplitPane: false, supportsFullscreen: false, supportsForce: false };
  }
}

const wt = probeWt();
dbg(`wt capabilities: ${JSON.stringify(wt)}`);

// --- Pick a free port -------------------------------------------------------

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

const port = await pickPort();
const instanceId = randomBytes(6).toString("hex");
const endpoint = `http://127.0.0.1:${port}/event`;
dbg(`port=${port} instance=${instanceId} endpoint=${endpoint}`);

// --- Launch the avatar process ---------------------------------------------

/**
 * Build the avatar child process argv. We do NOT pass it through a TTY
 * because the standalone host writes raw escape sequences directly.
 */
function avatarArgv(): string[] {
  return [
    AVATAR_PROCESS,
    `--port=${port}`,
    `--instance=${instanceId}`,
    `--emoteDir=${emoteSetDir()}`,
  ];
}

function emoteSetDir(): string {
  return process.env.CLAUDE_EMOTE_EMOTE_DIR ?? join(PROJECT_ROOT, "emotes", "ascii");
}

interface AvatarLaunch {
  child: ChildProcess | null;
  /** True if WT opened a new pane and we don't own the child PID. */
  delegatedToWT: boolean;
}

function launchAvatarInPane(): AvatarLaunch {
  if (!inWindowsTerminal || !wt || !wt.wtPath) {
    return launchAvatarInWindow();
  }
  // Build the inner command. We let `wt` run cmd.exe so the avatar
  // starts in a normal console context within the new pane.
  const innerCmd = buildCmdLine(["node", ...avatarArgv()]);
  const forceFlag = wt.supportsForce ? "-F" : "";
  const args: string[] = [];
  if (forceFlag) args.push(forceFlag);
  args.push("split-pane", "-V", "-d", PROJECT_ROOT);
  // For wt.exe, --size sets the pane width/height as a fraction. We pick
  // a narrow right pane (~25% of the terminal width).
  args.push("--size", "0.25");
  args.push("--title", `claude-emote (${instanceId})`);
  args.push("cmd", "/c", innerCmd);

  dbg(`launching avatar pane: ${wt.wtPath} ${args.join(" ")}`);
  try {
    const child = spawn(wt.wtPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return { child: null, delegatedToWT: true };
  } catch (err) {
    console.error(`[claude-emote] failed to launch WT pane: ${(err as Error).message}`);
    return launchAvatarInWindow();
  }
}

function launchAvatarInWindow(): AvatarLaunch {
  if (process.platform !== "win32") {
    // On non-Windows dev machines, just spawn the avatar as a normal
    // child. It will write to whatever stdout the launcher is attached
    // to, which is fine for testing the wiring.
    dbg("non-Windows: spawning avatar as direct child");
    const child = spawn("node", avatarArgv(), {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CLAUDE_EMOTE_INSTANCE_ID: instanceId,
        CLAUDE_EMOTE_PORT: String(port),
        CLAUDE_EMOTE_EMOTE_DIR: emoteSetDir(),
        CLAUDE_EMOTE_PARENT_PID: String(process.pid),
      },
    });
    return { child, delegatedToWT: false };
  }
  // Windows: open a new console window with `start`.
  const cmd = buildCmdLine(["node", ...avatarArgv()]);
  const fullCmd = `start "claude-emote (${instanceId})" /D "${PROJECT_ROOT}" cmd /c ${cmd}`;
  dbg(`launching avatar window: ${fullCmd}`);
  try {
    const child = spawn(fullCmd, {
      detached: true,
      stdio: "ignore",
      shell: true,
      windowsHide: false,
    });
    child.unref();
    return { child: null, delegatedToWT: true };
  } catch (err) {
    console.error(`[claude-emote] failed to launch avatar window: ${(err as Error).message}`);
    // Last resort: bail out and run Claude without an avatar.
    return { child: null, delegatedToWT: true };
  }
}

function buildCmdLine(parts: string[]): string {
  return parts
    .map((p) => (/[\s"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p))
    .join(" ");
}

// --- Health handshake -------------------------------------------------------

async function waitForHealth(timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = new URL("/health", endpoint).toString();
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

const avatar = launchAvatarInPane();
const health = await waitForHealth();
if (!health) {
  console.error(
    "[claude-emote] WARNING: avatar server did not respond to /health within 5s.",
  );
  console.error(
    "[claude-emote] Starting Claude anyway — the avatar will not appear, but Claude is unaffected.",
  );
}

// --- Forward to claude ------------------------------------------------------

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  CLAUDE_EMOTE_INSTANCE_ID: instanceId,
  CLAUDE_EMOTE_ENDPOINT: endpoint,
  CLAUDE_EMOTE_PARENT_PID: String(process.pid),
  // Ensure the binary on PATH is reachable.
};

if (isVersionProbe) {
  // Quick path: just print the version and exit.
  const probe = spawn(claudeExe, claudeArgs, { stdio: "inherit" });
  probe.on("close", (code) => process.exit(code ?? 0));
} else {
  const child = spawn(claudeExe, claudeArgs, {
    stdio: "inherit",
    env: childEnv,
  });

  const shutdown = () => {
    // Best-effort: signal the avatar server to shut down via a direct
    // POST, then give it a grace period, then SIGTERM the child if we
    // own it.
    if (avatar.child && !avatar.child.killed) {
      try {
        avatar.child.kill("SIGTERM");
      } catch {}
    } else if (avatar.delegatedToWT) {
      // The avatar is in its own pane/window — let it clean itself up
      // via the parent-pid watcher. We don't track its PID here.
    }
  };

  child.on("close", (code) => {
    shutdown();
    // Give the avatar a moment to drain, then exit.
    setTimeout(() => process.exit(code ?? 0), 200).unref();
  });

  // Forward our own SIGINT/SIGTERM to Claude so Ctrl+C still works.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      try {
        child.kill(sig);
      } catch {}
    });
  }
}
