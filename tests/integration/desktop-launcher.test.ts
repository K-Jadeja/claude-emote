import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(process.cwd());
const LAUNCHER = join(ROOT, "dist", "launcher", "claude-emote.js");
const FIXTURES = join(tmpdir(), `claude-emote-desktop-${process.pid}`);
const CLAUDE = join(FIXTURES, "claude.cjs");
const OVERLAY = join(FIXTURES, "overlay.cjs");
const BROKEN_OVERLAY = join(FIXTURES, "broken-overlay.cjs");
const CLAUDE_RECORD = join(FIXTURES, "claude.json");
const OVERLAY_RECORD = join(FIXTURES, "overlay.json");

beforeAll(() => {
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(
    CLAUDE,
    `
const fs = require("node:fs");
const http = require("node:http");
fs.writeFileSync(process.env.CLAUDE_RECORD, JSON.stringify({
  argv: process.argv.slice(2),
  endpoint: process.env.CLAUDE_EMOTE_ENDPOINT || null,
  capability: process.env.CLAUDE_EMOTE_CAPABILITY_TOKEN || null,
  sessionLabel: process.env.CLAUDE_EMOTE_SESSION_LABEL || null,
  hideSessionLabel: process.env.CLAUDE_EMOTE_HIDE_SESSION_LABEL || null
}));
const endpoint = process.env.CLAUDE_EMOTE_ENDPOINT;
const token = process.env.CLAUDE_EMOTE_CAPABILITY_TOKEN;
if (!endpoint || !token) process.exit(Number(process.env.CLAUDE_EXIT || 0));
const url = new URL(endpoint);
const body = JSON.stringify({ hook_event_name: "SessionEnd", session_id: "test" });
const req = http.request(url, {
  method: "POST",
  headers: {
    authorization: "Bearer " + token,
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  }
}, (res) => { res.resume(); res.on("end", () => process.exit(Number(process.env.CLAUDE_EXIT || 0))); });
req.on("error", () => process.exit(91));
req.end(body);
`,
  );
  writeFileSync(
    OVERLAY,
    `
const fs = require("node:fs");
const http = require("node:http");
const endpoint = process.env.CLAUDE_EMOTE_ENDPOINT;
const token = process.env.CLAUDE_EMOTE_CAPABILITY_TOKEN;
fs.writeFileSync(process.env.OVERLAY_RECORD, JSON.stringify({
  pid: process.pid,
  argv: process.argv.slice(2),
  endpoint,
  sessionLabel: process.env.CLAUDE_EMOTE_SESSION_LABEL || null,
  hideSessionLabel: process.env.CLAUDE_EMOTE_HIDE_SESSION_LABEL || null,
  tokenPresent: Boolean(token),
  tokenInArgv: process.argv.some((arg) => arg.includes(token || "__missing__"))
}));
const url = new URL("/overlay-ready", endpoint);
const req = http.request(url, {
  method: "POST",
  headers: { authorization: "Bearer " + token }
}, (res) => { res.resume(); res.on("end", () => setInterval(() => {}, 1000)); });
req.on("error", (error) => { console.error(error); process.exit(9); });
req.end();
`,
  );
  writeFileSync(BROKEN_OVERLAY, "process.exit(7);\n");
});

afterAll(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
});

function run(
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [LAUNCHER, ...args], {
      env: {
        ...process.env,
        CLAUDE_EMOTE_CLAUDE_EXE: CLAUDE,
        CLAUDE_EMOTE_RENDERER: "desktop",
        CLAUDE_EMOTE_TEST_PLATFORM: "win32",
        CLAUDE_EMOTE_OVERLAY_EXE: OVERLAY,
        CLAUDE_EMOTE_HEALTH_TIMEOUT_MS: "3000",
        CLAUDE_EMOTE_SESSION_END_GRACE_MS: "100",
        CLAUDE_EMOTE_ENDED_DISPLAY_MS: "0",
        CLAUDE_RECORD,
        OVERLAY_RECORD,
        CLAUDE_EXIT: "23",
        ...extraEnv,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`launcher timed out:\n${stderr}`));
    }, 15_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? -1, stderr });
    });
  });
}

describe("one-command desktop launcher", () => {
  it("starts the host and overlay, preserves Claude argv/exit, and keeps the token out of argv", async () => {
    const result = await run(["--resume", "--model", "opus"]);
    expect(result.code).toBe(23);
    const claude = JSON.parse(readFileSync(CLAUDE_RECORD, "utf8"));
    expect(claude.argv.slice(0, 3)).toEqual(["--resume", "--model", "opus"]);
    expect(claude.argv).toContain("--plugin-dir");
    expect(claude.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/event$/);
    expect(claude.capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(claude.sessionLabel).toBeNull();
    expect(claude.hideSessionLabel).toBeNull();

    const overlay = JSON.parse(readFileSync(OVERLAY_RECORD, "utf8"));
    expect(overlay.sessionLabel).toBe(basename(ROOT));
    expect(overlay.hideSessionLabel).toBeNull();
    expect(overlay.tokenPresent).toBe(true);
    expect(overlay.tokenInArgv).toBe(false);
    expect(overlay.argv.join(" ")).not.toContain(overlay.endpoint);
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    expect(() => process.kill(overlay.pid, 0)).toThrow();
  }, 20_000);

  it("honors an explicit private label without leaking its config to Claude", async () => {
    const result = await run([], {
      CLAUDE_EMOTE_SESSION_LABEL: "  Private pet  ",
      CLAUDE_EXIT: "0",
    });
    expect(result.code).toBe(0);
    const overlay = JSON.parse(readFileSync(OVERLAY_RECORD, "utf8"));
    expect(overlay.sessionLabel).toBe("Private pet");
    const claude = JSON.parse(readFileSync(CLAUDE_RECORD, "utf8"));
    expect(claude.sessionLabel).toBeNull();
  }, 20_000);

  it("passes the hide decision only to the overlay", async () => {
    const result = await run([], {
      CLAUDE_EMOTE_HIDE_SESSION_LABEL: "1",
      CLAUDE_EXIT: "0",
    });
    expect(result.code).toBe(0);
    const overlay = JSON.parse(readFileSync(OVERLAY_RECORD, "utf8"));
    expect(overlay.sessionLabel).toBeNull();
    expect(overlay.hideSessionLabel).toBe("1");
    const claude = JSON.parse(readFileSync(CLAUDE_RECORD, "utf8"));
    expect(claude.hideSessionLabel).toBeNull();
  }, 20_000);

  it("runs Claude cleanly without hooks when the overlay cannot render", async () => {
    const result = await run(["--resume"], {
      CLAUDE_EMOTE_OVERLAY_EXE: BROKEN_OVERLAY,
      CLAUDE_EXIT: "0",
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("desktop pet failed to render");
    const claude = JSON.parse(readFileSync(CLAUDE_RECORD, "utf8"));
    expect(claude.argv).toEqual(["--resume"]);
    expect(claude.endpoint).toBeNull();
    expect(claude.capability).toBeNull();
  }, 20_000);

  it("--no-emote bypasses every companion component", async () => {
    rmSync(OVERLAY_RECORD, { force: true });
    const result = await run(["--no-emote", "--resume"], {
      CLAUDE_EMOTE_OVERLAY_EXE: join(FIXTURES, "does-not-exist.exe"),
      CLAUDE_EXIT: "0",
    });
    expect(result.code).toBe(0);
    const claude = JSON.parse(readFileSync(CLAUDE_RECORD, "utf8"));
    expect(claude.argv).toEqual(["--resume"]);
    expect(claude.endpoint).toBeNull();
    expect(existsSync(OVERLAY_RECORD)).toBe(false);
  }, 20_000);
});
