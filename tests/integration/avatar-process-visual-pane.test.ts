/**
 * avatar-process-visual-pane.test.ts (P10.1)
 *
 * Deterministic subprocess tests for both avatar-process output
 * modes:
 *
 *   - normal / attached / test mode: behaves exactly as Phase 10
 *     did. READY on stdout, fallback warning on stderr, etc.
 *   - visual-pane mode (CLAUDE_EMOTE_VISUAL_PANE=1): the pane is
 *     exclusive to frames. No READY, no fallback warning, no
 *     installed-package paths, no debug logs, no server event logs.
 *     /health is the readiness signal. A clear+home initializes the
 *     pane once before the first frame.
 *
 * No host Chafa dependency: every test runs the avatar with a
 * restricted PATH so the fallback fires deterministically.
 *
 * In visual-pane mode the test sets CLAUDE_EMOTE_LOG_FILE so the
 * suppressed READY marker still reaches the test log — the test
 * itself observes the port from the log file. The pane stdout /
 * stderr stay clean.
 */

import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";

const PROJECT_ROOT = process.cwd();
const AVATAR = join(PROJECT_ROOT, "dist", "host", "avatar-process.js");
const NODE = process.execPath;

function requestJson(
  port: number,
  path: string,
  method: string,
  body?: string,
  timeoutMs = 2000,
): Promise<{ code: number; body: string }> {
  return new Promise((resolveOne) => {
    const opts: import("node:http").RequestOptions = {
      host: "127.0.0.1",
      port,
      path,
      method,
      timeout: timeoutMs,
    };
    if (body) {
      opts.headers = {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      };
    }
    const req = httpRequest(opts, (r) => {
      let buf = "";
      r.setEncoding("utf8");
      r.on("data", (c: string) => (buf += c));
      r.on("end", () => resolveOne({ code: r.statusCode ?? -1, body: buf }));
    });
    req.on("error", () => resolveOne({ code: -1, body: "" }));
    req.on("timeout", () => {
      req.destroy();
      resolveOne({ code: -1, body: "timeout" });
    });
    if (body) req.write(body);
    req.end();
  });
}

async function waitForHealth(
  port: number,
  timeoutMs = 4000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    last = (await requestJson(port, "/health", "GET")).code;
    if (last === 200) return last;
    await new Promise((r) => setTimeout(r, 25));
  }
  return last;
}

async function waitForLogReady(
  logPath: string,
  timeoutMs = 4000,
): Promise<{ port: number } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      const text = readFileSync(logPath, "utf8");
      const pm = text.match(/CLAUDE_EMOTE_READY[^\n]*port=(\d+)/);
      if (pm) return { port: Number(pm[1]) };
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

function spawnAvatar(
  env: NodeJS.ProcessEnv,
  cwd: string,
  args: string[],
): { child: ChildProcess; stdout: { value: string }; stderr: { value: string } } {
  const child = spawn(NODE, [AVATAR, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    cwd,
  });
  const stdout = { value: "" };
  const stderr = { value: "" };
  child.stdout?.on("data", (b: Buffer) => (stdout.value += b.toString("utf8")));
  child.stderr?.on("data", (b: Buffer) => (stderr.value += b.toString("utf8")));
  return { child, stdout, stderr };
}

function missingChafaEnv(
  base: NodeJS.ProcessEnv,
  cwd: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of [
    "WT_SESSION", "TERM_PROGRAM", "ITERM_SESSION_ID",
    "KITTY_WINDOW_ID", "WEZTERM_PANE", "GHOSTTY_RESOURCES_DIR",
    "TMUX", "ZELLIJ_SESSION_NAME", "ZELLIJ",
    "CLAUDE_EMOTE_PORT", "CLAUDE_EMOTE_INSTANCE_ID",
    "CLAUDE_EMOTE_EMOTE_DIR", "CLAUDE_EMOTE_PARENT_PID",
    "CLAUDE_EMOTE_LOG_FILE", "CLAUDE_EMOTE_DEBUG",
    "CLAUDE_EMOTE_DEMO_PROTOCOL",
    "CLAUDE_EMOTE_CHAFA_PATH", "PI_EMOTE_CHAFA_PATH",
  ]) delete env[k];
  env.PATH = cwd;
  env.LOCALAPPDATA = cwd;
  return env;
}

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGTERM"); } catch {}
  await new Promise<void>((resolveOne) => {
    const t = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolveOne();
    }, 5_000);
    child.once("close", () => {
      clearTimeout(t);
      resolveOne();
    });
  });
}

describe("avatar-process visual-pane mode (P10.1, deterministic missing-Chafa)", () => {
  it(
    "visual-pane mode: no READY, no fallback warning, no paths, no event logs; /health 200; think + idle frames emitted",
    async () => {
      const tmp = join(tmpdir(), "avatar-p10-1-visual-pane-" + Date.now());
      mkdirSync(tmp, { recursive: true });
      const logFile = join(tmp, "visual-pane.log");
      try {
        const env = missingChafaEnv(process.env, tmp);
        env.CLAUDE_EMOTE_VISUAL_PANE = "1";
        // Log file captures the suppressed READY so the test can
        // learn the bound port. The pane stdout / stderr stay clean.
        env.CLAUDE_EMOTE_LOG_FILE = logFile;
        const { child, stdout, stderr } = spawnAvatar(
          env,
          tmp,
          [
            "--port=0",
            "--instance=visual-pane-missing-chafa",
          ],
        );

        // Learn the port from the log file (visual-pane mode
        // suppresses READY from stdout; the policy writes it to the
        // log file when one is configured).
        const ready = await waitForLogReady(logFile);
        expect(ready).not.toBeNull();
        if (!ready) {
          await killChild(child);
          return;
        }

        // /health must respond 200.
        const healthCode = await waitForHealth(ready.port, 2_000);
        expect(healthCode).toBe(200);

        // Drive a UserPromptSubmit and observe a think frame.
        const stdoutBeforeThink = stdout.value.length;
        const thinkEvent = JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "visual-pane-missing-chafa",
          prompt: "v",
        });
        const postThink = await requestJson(
          ready.port,
          "/event",
          "POST",
          thinkEvent,
        );
        expect(postThink.code).toBe(200);
        const thinkDeadline = Date.now() + 4_000;
        let thinkSeen = false;
        while (Date.now() < thinkDeadline) {
          if (stdout.value.slice(stdoutBeforeThink).includes("(•_ • )?")) {
            thinkSeen = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(thinkSeen).toBe(true);

        // Drive a Stop and observe an idle frame.
        const stdoutBeforeStop = stdout.value.length;
        const stopEvent = JSON.stringify({
          hook_event_name: "Stop",
          session_id: "visual-pane-missing-chafa",
        });
        const postStop = await requestJson(
          ready.port,
          "/event",
          "POST",
          stopEvent,
        );
        expect(postStop.code).toBe(200);
        const stopDeadline = Date.now() + 4_000;
        let idleSeen = false;
        while (Date.now() < stopDeadline) {
          if (stdout.value.slice(stdoutBeforeStop).includes("(• ◡ •)")) {
            idleSeen = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(idleSeen).toBe(true);

        await killChild(child);

        // The pane stdout MUST NOT contain READY, paths, or server
        // event logs.
        expect(stdout.value).not.toContain("CLAUDE_EMOTE_READY");
        expect(stdout.value).not.toMatch(/emoteDir=/);
        expect(stdout.value).not.toMatch(/\[avatar-server\]/);
        expect(stdout.value).not.toMatch(/\[avatar-process\]/);
        // stderr MUST NOT contain the fallback warning or installed
        // paths. The "falling back" string is the Phase 10 warning
        // that previously corrupted the pane.
        expect(stderr.value).not.toMatch(/falling back to bundled ASCII/i);
        expect(stderr.value).not.toMatch(/emoteDir=/);
        expect(stderr.value).not.toMatch(/\[avatar-process\]/);
        expect(stderr.value).not.toMatch(/\[avatar-server\]/);

        // One clear+home initialization must precede the first frame.
        const clearCount = (stdout.value.match(/\x1b\[2J\x1b\[H/g) || []).length;
        expect(clearCount).toBe(1);

        // The first 64 bytes after the clear sequence must be either
        // a frame payload (cursor-home + lines) or further frame
        // bytes — never a wrapped diagnostic line.
        const afterClearIdx =
          stdout.value.indexOf("\x1b[2J\x1b[H") + "\x1b[2J\x1b[H".length;
        const head = stdout.value.slice(afterClearIdx, afterClearIdx + 64);
        expect(head).not.toMatch(/preferred/);
        expect(head).not.toMatch(/bundled/);
        expect(head).not.toMatch(/emoteDir/);
        expect(head).not.toMatch(/instance=/);

        // The log file, by contrast, contains the suppressed READY.
        const log = readFileSync(logFile, "utf8");
        expect(log).toContain("CLAUDE_EMOTE_READY");
        expect(log).toMatch(/port=\d+/);

        // PID must be gone.
        let alive = false;
        try {
          if (child.pid !== undefined) process.kill(child.pid, 0);
          alive = true;
        } catch {}
        expect(alive).toBe(false);
      } finally {
        try { rmSync(tmp, { recursive: true, force: true }); } catch {}
      }
    },
    30_000,
  );

  it(
    "normal (attached / test) mode with missing Chafa: warning + READY + /health + think + idle are preserved",
    async () => {
      const tmp = join(tmpdir(), "avatar-p10-1-normal-" + Date.now());
      mkdirSync(tmp, { recursive: true });
      try {
        const env = missingChafaEnv(process.env, tmp);
        // CLAUDE_EMOTE_VISUAL_PANE intentionally NOT set.
        // CLAUDE_EMOTE_LOG_FILE intentionally NOT set.
        const { child, stdout, stderr } = spawnAvatar(
          env,
          tmp,
          [
            "--port=0",
            "--instance=normal-missing-chafa",
          ],
        );

        // In normal mode READY is on stdout — poll for it directly.
        const readyDeadline = Date.now() + 4_000;
        let readyPort = 0;
        while (Date.now() < readyDeadline) {
          if (stdout.value.includes("CLAUDE_EMOTE_READY")) {
            const line = stdout.value
              .split(/\r?\n/)
              .find((l) => l.includes("CLAUDE_EMOTE_READY")) ?? "";
            const pm = line.match(/port=(\d+)/);
            if (pm) {
              readyPort = Number(pm[1]);
              break;
            }
          }
          if (child.exitCode !== null) break;
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(readyPort).toBeGreaterThan(0);

        // /health must respond 200.
        const healthCode = await waitForHealth(readyPort, 2_000);
        expect(healthCode).toBe(200);

        // UserPromptSubmit → think frame.
        const stdoutBeforeThink = stdout.value.length;
        const thinkEvent = JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "normal-missing-chafa",
          prompt: "n",
        });
        const postThink = await requestJson(
          readyPort,
          "/event",
          "POST",
          thinkEvent,
        );
        expect(postThink.code).toBe(200);
        const thinkDeadline = Date.now() + 4_000;
        let thinkSeen = false;
        while (Date.now() < thinkDeadline) {
          if (stdout.value.slice(stdoutBeforeThink).includes("(•_ • )?")) {
            thinkSeen = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(thinkSeen).toBe(true);

        // Stop → idle frame.
        const stdoutBeforeStop = stdout.value.length;
        const stopEvent = JSON.stringify({
          hook_event_name: "Stop",
          session_id: "normal-missing-chafa",
        });
        const postStop = await requestJson(
          readyPort,
          "/event",
          "POST",
          stopEvent,
        );
        expect(postStop.code).toBe(200);
        const stopDeadline = Date.now() + 4_000;
        let idleSeen = false;
        while (Date.now() < stopDeadline) {
          if (stdout.value.slice(stdoutBeforeStop).includes("(• ◡ •)")) {
            idleSeen = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(idleSeen).toBe(true);

        await killChild(child);

        // READY on stdout, warning on stderr — Phase 10 contract.
        expect(stdout.value).toContain("CLAUDE_EMOTE_READY");
        expect(stderr.value).toMatch(/falling back to bundled ASCII/i);
        // emoteDir in the READY line is normal.
        expect(stdout.value).toMatch(/emoteDir=/);
        // No clear+home in normal mode.
        const clearCount = (stdout.value.match(/\x1b\[2J\x1b\[H/g) || []).length;
        expect(clearCount).toBe(0);
      } finally {
        try { rmSync(tmp, { recursive: true, force: true }); } catch {}
      }
    },
    30_000,
  );

  it(
    "fatal visual-pane startup: no READY, one concise fatal line, nonzero exit, no child survives",
    async () => {
      const tmp = join(tmpdir(), "avatar-p10-1-fatal-" + Date.now());
      mkdirSync(tmp, { recursive: true });
      try {
        // Project config selects the image protocol so the preferred
        // attempt fails (Chafa missing). Then point --emoteDir at a
        // path that has NO bundled ASCII so the fallback ALSO fails.
        const cfgDir = join(
          tmp,
          ".claude-emote",
          "extensions",
          "claude-emote",
        );
        mkdirSync(cfgDir, { recursive: true });
        writeFileSync(
          join(cfgDir, "config.json"),
          JSON.stringify({
            terminals: [{ match: "unknown", render: "sixel" }],
          }),
          "utf8",
        );

        const env = missingChafaEnv(process.env, tmp);
        env.CLAUDE_EMOTE_VISUAL_PANE = "1";
        // An explicit custom emote dir that does not exist forces the
        // fallback to fail (custom emote + ASCII mismatch).
        const nonexistentDir = join(tmp, "no-such-emotes");
        const { child, stdout, stderr } = spawnAvatar(
          env,
          tmp,
          [
            "--port=0",
            "--instance=fatal-visual-pane",
            `--emoteDir=${nonexistentDir}`,
          ],
        );

        // The avatar must exit quickly (within 5s) with a nonzero code.
        const exited = await Promise.race<{ code: number | null } | "timeout">([
          new Promise<{ code: number | null }>((r) =>
            child.once("close", (code) => r({ code })),
          ),
          new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5_000)),
        ]);
        if (exited === "timeout") {
          try { child.kill("SIGKILL"); } catch {}
          throw new Error(
            `avatar did not exit within 5s; stdout=${stdout.value.slice(-200)} stderr=${stderr.value.slice(-200)}`,
          );
        }
        // Exited nonzero.
        expect(exited.code).not.toBe(0);
        expect(exited.code).not.toBeNull();

        // Output contract: no READY (suppressed), exactly one concise
        // fatal line on stderr, no /health succeeded because the
        // server never bound.
        expect(stdout.value).not.toContain("CLAUDE_EMOTE_READY");
        // The policy allows one fatal line; the stderr count of
        // fatal markers must be exactly one (the dedup holds).
        const fatalCount = (stderr.value.match(/\[avatar-process\]/g) || []).length;
        expect(fatalCount).toBe(1);
        // And nothing else leaked into the visual surface.
        expect(stdout.value).not.toMatch(/\[avatar-process\]/);
        expect(stdout.value).not.toMatch(/\[avatar-server\]/);
        // No clear+home — the renderer never owned the pane.
        expect(stdout.value).not.toContain("\x1b[2J\x1b[H");

        // No child PID remains.
        let alive = false;
        try {
          if (child.pid !== undefined) process.kill(child.pid, 0);
          alive = true;
        } catch {}
        expect(alive).toBe(false);
      } finally {
        try { rmSync(tmp, { recursive: true, force: true }); } catch {}
      }
    },
    20_000,
  );

  it(
    "fatal visual-pane startup with a bad auto-emote selection still exits cleanly (no PANIC)",
    async () => {
      const tmp = join(tmpdir(), "avatar-p10-1-fatal-bad-auto-" + Date.now());
      mkdirSync(tmp, { recursive: true });
      const logFile = join(tmp, "fatal-bad-auto.log");
      try {
        const cfgDir = join(
          tmp,
          ".claude-emote",
          "extensions",
          "claude-emote",
        );
        mkdirSync(cfgDir, { recursive: true });
        writeFileSync(
          join(cfgDir, "config.json"),
          JSON.stringify({
            terminals: [{ match: "unknown", render: "sixel" }],
          }),
          "utf8",
        );

        const env = missingChafaEnv(process.env, tmp);
        env.CLAUDE_EMOTE_VISUAL_PANE = "1";
        env.CLAUDE_EMOTE_LOG_FILE = logFile;
        const { child, stdout, stderr } = spawnAvatar(
          env,
          tmp,
          [
            "--port=0",
            "--instance=fatal-visual-pane-bad-auto",
          ],
        );

        // In the happy bundled-ASCII path the avatar starts and
        // /health returns 200 within a second. If anything in the
        // fallback chain fails, the avatar must exit with a single
        // fatal line. Either outcome is acceptable for this test —
        // what matters is "no spam, no zombie PID, no surprise
        // readiness".
        const ready = await waitForLogReady(logFile);
        let healthCode = -1;
        if (ready) {
          healthCode = await waitForHealth(ready.port, 2_000);
        }

        if (healthCode === 200) {
          // The fallback succeeded — there should be NO fatal line
          // and exactly one clear+home.
          await killChild(child);
          expect(stderr.value).not.toMatch(/\[avatar-process\]/);
          expect(stdout.value).not.toContain("CLAUDE_EMOTE_READY");
          const clearCount = (stdout.value.match(/\x1b\[2J\x1b\[H/g) || []).length;
          expect(clearCount).toBe(1);
        } else {
          // The fallback failed — at most one fatal line is allowed
          // and there must be no /health success and no READY.
          await killChild(child);
          expect(stdout.value).not.toContain("CLAUDE_EMOTE_READY");
          const fatalCount = (stderr.value.match(/\[avatar-process\]/g) || []).length;
          expect(fatalCount).toBeLessThanOrEqual(1);
        }
      } finally {
        try { rmSync(tmp, { recursive: true, force: true }); } catch {}
      }
    },
    20_000,
  );
});
