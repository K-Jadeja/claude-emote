/**
 * hook-bridge integration test
 *
 * Spawns the compiled bridge (dist/claude/hook-bridge.js) as a child process
 * with a known stdin payload and CLAUDE_EMOTE_ENDPOINT, and verifies:
 *
 *   - process.exit code is 0
 *   - stdout is empty
 *   - the JSON payload arrives at the local test server unchanged
 *   - the bridge exits 0 even when the endpoint is unreachable
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BRIDGE = join(process.cwd(), "dist", "claude", "hook-bridge.js");
const FIXTURE = join(process.cwd(), "tests", "fixtures", "PreToolUse_Read.json");

interface CapturedRequest {
  method: string;
  url: string;
  body: string;
  contentType: string | undefined;
}

let server: Server;
let captured: CapturedRequest[] = [];
let port = 0;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      captured.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body,
        contentType: req.headers["content-type"],
      });
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function runBridge(opts: {
  endpoint: string | null;
  stdin: string;
  debug?: boolean;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    if (opts.endpoint === null) delete env.CLAUDE_EMOTE_ENDPOINT;
    else env.CLAUDE_EMOTE_ENDPOINT = opts.endpoint;
    if (opts.debug) env.CLAUDE_EMOTE_DEBUG = "1";
    else delete env.CLAUDE_EMOTE_DEBUG;

    const child = spawn("node", [BRIDGE], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code, stdout, stderr }));
    child.stdin.end(opts.stdin);
  });
}

describe("hook-bridge (M3 integration)", () => {
  it("forwards the unmodified payload to the local endpoint", async () => {
    captured = [];
    const input = readFileSync(FIXTURE, "utf8");
    const result = await runBridge({
      endpoint: `http://127.0.0.1:${port}/event`,
      stdin: input,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(captured.length).toBe(1);
    expect(captured[0]!.method).toBe("POST");
    expect(captured[0]!.url).toBe("/event");
    expect(captured[0]!.contentType).toBe("application/json");
    // Unmodified: parse both and deep-equal.
    expect(JSON.parse(captured[0]!.body)).toEqual(JSON.parse(input));
  });

  it("exits 0 and prints nothing when endpoint env var is missing", async () => {
    const result = await runBridge({ endpoint: null, stdin: '{"hook_event_name":"x"}' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 and prints nothing when endpoint is unreachable", async () => {
    const result = await runBridge({
      endpoint: "http://127.0.0.1:1/event", // port 1: refused
      stdin: '{"hook_event_name":"Stop"}',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 and prints nothing when stdin is malformed JSON", async () => {
    captured = [];
    const result = await runBridge({
      endpoint: `http://127.0.0.1:${port}/event`,
      stdin: "not json at all",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    // The bridge forwards stdin raw, so the server still receives it.
    expect(captured.length).toBe(1);
    expect(captured[0]!.body).toBe("not json at all");
  });

  it("exits 0 and prints nothing when stdin is empty", async () => {
    captured = [];
    const result = await runBridge({
      endpoint: `http://127.0.0.1:${port}/event`,
      stdin: "",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(captured.length).toBe(0);
  });

  it("does not write to stderr unless CLAUDE_EMOTE_DEBUG=1", async () => {
    const result = await runBridge({
      endpoint: "http://127.0.0.1:1/event",
      stdin: '{"hook_event_name":"Stop"}',
    });
    expect(result.stderr).toBe("");
  });

  it("writes to stderr only when CLAUDE_EMOTE_DEBUG=1", async () => {
    const result = await runBridge({
      endpoint: "http://127.0.0.1:1/event",
      stdin: '{"hook_event_name":"Stop"}',
      debug: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/claude-emote bridge/);
  });
});
