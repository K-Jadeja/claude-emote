/**
 * avatar-server-focus.test.ts
 *
 * Integration tests for the `POST /focus` route on the per-session
 * host. Spawns the compiled session-host-process.js with a fake
 * `wt.exe` so the host's focuser has a real executable to drive
 * without touching the user's machine.
 *
 * The fake-wt script handles `focus-tab --target 0 -w <windowId>`
 * like the real Windows Terminal. It records its argv to a JSON
 * file so the test can verify the host issued the right command
 * with the right window GUID.
 */

import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOST = join(process.cwd(), "dist", "host", "session-host-process.js");
const TOKEN = "avatar_server_focus_test_capability_1234567890";
const FAKE_DIR = join(tmpdir(), "claude-emote-focus-" + Date.now());
const FAKE_WT = join(FAKE_DIR, "fake-wt.cjs");
const WT_RECORD = join(FAKE_DIR, "wt-record.json");

const WINDOW_ID = "3a9e3981-828c-4145-83d8-eea2c0846260";

let child: ChildProcess | null = null;
let port = 0;

beforeAll(() => {
  mkdirSync(FAKE_DIR, { recursive: true });
  // The fake records every call into a JSON file. It responds to
  // `focus-tab --target 0 -w <id>` by exiting 0 (or non-zero when
  // FAKE_WT_FAIL_NEXT is set) and recording the argv.
  writeFileSync(
    FAKE_WT,
    `
const fs = require("node:fs");
const recordPath = process.env.FAKE_WT_RECORD;
const argv = process.argv.slice(2);

const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
record.calls = record.calls || [];
record.calls.push(argv);
fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));

if (argv[0] === "focus-tab") {
  if (process.env.FAKE_WT_FAIL_NEXT === "1") {
    process.env.FAKE_WT_FAIL_NEXT = "0";
    process.exit(1);
  }
  process.exit(0);
}

process.exit(2);
`,
    "utf8",
  );
  // Seed the record file before the first call.
  writeFileSync(WT_RECORD, JSON.stringify({ calls: [] }, null, 2));
});

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await new Promise<void>((resolveOne) =>
      child!.once("exit", () => resolveOne()),
    );
  }
  child = null;
  if (existsSync(WT_RECORD)) {
    writeFileSync(WT_RECORD, JSON.stringify({ calls: [] }, null, 2));
  }
});

async function spawnHost(
  extraEnv: Record<string, string> = {},
): Promise<number> {
  const stdout = { value: "" };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_EMOTE_CAPABILITY_TOKEN: TOKEN,
    FAKE_WT_RECORD: WT_RECORD,
    ...extraEnv,
  };
  child = spawn(
    process.execPath,
    [
      HOST,
      "--port=0",
      `--instance=focus-test`,
      `--parentPid=${process.pid}`,
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.on("data", (chunk) => (stdout.value += chunk.toString("utf8")));
  child.stderr?.on("data", () => {}); // swallow

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const line = stdout.value
      .split(/\r?\n/)
      .find((c) => c.includes("CLAUDE_EMOTE_SESSION_READY"));
    const match = line?.match(/port=(\d+)/);
    if (match) return Number(match[1]);
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`session host did not become ready:\n${stdout.value}`);
}

async function rawRequest(
  portNumber: number,
  options: {
    method: string;
    path: string;
    authorization?: string;
    origin?: string;
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolveOne, rejectError) => {
    const headers: Record<string, string> = {};
    if (options.authorization !== undefined) {
      headers.authorization = options.authorization;
    }
    if (options.origin !== undefined) {
      headers.origin = options.origin;
    }
    const req = request(
      {
        host: "127.0.0.1",
        port: portNumber,
        path: options.path,
        method: options.method,
        headers,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolveOne({ status: res.statusCode ?? 0, body }),
        );
      },
    );
    req.on("error", rejectError);
    req.end();
  });
}

function readCalls(): string[][] {
  return JSON.parse(readFileSync(WT_RECORD, "utf8")).calls as string[][];
}

describe("renderer-free session host /focus route", () => {
  it("returns 204 with valid capability and invokes wt.exe focus-tab with the launcher's window GUID", async () => {
    port = await spawnHost({
      CLAUDE_EMOTE_WT_EXE: FAKE_WT,
      CLAUDE_EMOTE_WT_WINDOW_ID: WINDOW_ID,
    });
    const res = await rawRequest(port, {
      method: "POST",
      path: "/focus",
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(204);
    expect(res.body).toBe("");
    const calls = readCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "focus-tab",
      "--target",
      "0",
      "-w",
      WINDOW_ID,
    ]);
  });

  it("returns 401 without a capability header", async () => {
    port = await spawnHost({
      CLAUDE_EMOTE_WT_EXE: FAKE_WT,
      CLAUDE_EMOTE_WT_WINDOW_ID: WINDOW_ID,
    });
    const res = await rawRequest(port, { method: "POST", path: "/focus" });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(readCalls()).toEqual([]);
  });

  it("returns 401 with an incorrect capability", async () => {
    port = await spawnHost({
      CLAUDE_EMOTE_WT_EXE: FAKE_WT,
      CLAUDE_EMOTE_WT_WINDOW_ID: WINDOW_ID,
    });
    const res = await rawRequest(port, {
      method: "POST",
      path: "/focus",
      authorization: "Bearer not-the-real-token",
    });
    expect(res.status).toBe(401);
    expect(readCalls()).toEqual([]);
  });

  it("returns 403 for a non-loopback browser origin", async () => {
    port = await spawnHost({
      CLAUDE_EMOTE_WT_EXE: FAKE_WT,
      CLAUDE_EMOTE_WT_WINDOW_ID: WINDOW_ID,
    });
    const res = await rawRequest(port, {
      method: "POST",
      path: "/focus",
      authorization: `Bearer ${TOKEN}`,
      origin: "https://evil.example.com",
    });
    expect(res.status).toBe(403);
    expect(readCalls()).toEqual([]);
  });

  it("returns 404 for non-POST methods on /focus", async () => {
    port = await spawnHost({
      CLAUDE_EMOTE_WT_EXE: FAKE_WT,
      CLAUDE_EMOTE_WT_WINDOW_ID: WINDOW_ID,
    });
    const res = await rawRequest(port, {
      method: "GET",
      path: "/focus",
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(404);
    expect(readCalls()).toEqual([]);
  });

  it("answers an OPTIONS preflight on /focus with 204 and POST allowed", async () => {
    port = await spawnHost({
      CLAUDE_EMOTE_WT_EXE: FAKE_WT,
      CLAUDE_EMOTE_WT_WINDOW_ID: WINDOW_ID,
    });
    const res = await rawRequest(port, {
      method: "OPTIONS",
      path: "/focus",
      origin: "http://127.0.0.1:4312",
    });
    expect(res.status).toBe(204);
    expect(readCalls()).toEqual([]);
  });

  it("returns 204 with no wt.exe I/O when CLAUDE_EMOTE_WT_EXE is empty", async () => {
    port = await spawnHost({
      CLAUDE_EMOTE_WT_EXE: "",
      CLAUDE_EMOTE_WT_WINDOW_ID: WINDOW_ID,
    });
    const res = await rawRequest(port, {
      method: "POST",
      path: "/focus",
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(204);
    expect(readCalls()).toEqual([]);
  });

  it("returns 204 with no wt.exe I/O when CLAUDE_EMOTE_WT_EXE is unset", async () => {
    port = await spawnHost({
      CLAUDE_EMOTE_WT_WINDOW_ID: WINDOW_ID,
    });
    const res = await rawRequest(port, {
      method: "POST",
      path: "/focus",
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(204);
    expect(readCalls()).toEqual([]);
  });

  it("returns 204 silently when CLAUDE_EMOTE_WT_WINDOW_ID is missing (refuses to open a new window)", async () => {
    port = await spawnHost({
      CLAUDE_EMOTE_WT_EXE: FAKE_WT,
      // No CLAUDE_EMOTE_WT_WINDOW_ID — defensive guard prevents
      // `wt.exe focus-tab -w 0` from spawning a new WT window.
    });
    const res = await rawRequest(port, {
      method: "POST",
      path: "/focus",
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(204);
    expect(readCalls()).toEqual([]);
  });

  it("returns 204 even when focus-tab exits non-zero (defensive)", async () => {
    port = await spawnHost({
      CLAUDE_EMOTE_WT_EXE: FAKE_WT,
      CLAUDE_EMOTE_WT_WINDOW_ID: WINDOW_ID,
      FAKE_WT_FAIL_NEXT: "1",
    });
    const res = await rawRequest(port, {
      method: "POST",
      path: "/focus",
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(204);
    expect(readCalls()).toHaveLength(1);
  });

  it("dedupes two concurrent /focus calls into a single focus-tab call", async () => {
    port = await spawnHost({
      CLAUDE_EMOTE_WT_EXE: FAKE_WT,
      CLAUDE_EMOTE_WT_WINDOW_ID: WINDOW_ID,
    });
    const [a, b] = await Promise.all([
      rawRequest(port, {
        method: "POST",
        path: "/focus",
        authorization: `Bearer ${TOKEN}`,
      }),
      rawRequest(port, {
        method: "POST",
        path: "/focus",
        authorization: `Bearer ${TOKEN}`,
      }),
    ]);
    expect(a.status).toBe(204);
    expect(b.status).toBe(204);
    const calls = readCalls();
    expect(calls).toHaveLength(1);
  });
});

process.on("exit", () => {
  try {
    rmSync(FAKE_DIR, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});