import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const HOST = join(
  process.cwd(),
  "dist",
  "host",
  "session-host-process.js",
);
const TOKEN = "session_host_test_capability_1234567890";
let child: ChildProcess | null = null;

function post(
  port: number,
  path: string,
  body: unknown,
  token = TOKEN,
): Promise<{ status: number; body: string }> {
  const json = JSON.stringify(body);
  return new Promise((resolveOne, rejectError) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(json),
        },
      },
      (res) => {
        let responseBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () =>
          resolveOne({
            status: res.statusCode ?? 0,
            body: responseBody,
          }),
        );
      },
    );
    req.on("error", rejectError);
    req.end(json);
  });
}

async function waitForReady(
  stdout: { value: string },
  timeoutMs = 5_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const line = stdout.value
      .split(/\r?\n/)
      .find((candidate) => candidate.includes("CLAUDE_EMOTE_SESSION_READY"));
    const match = line?.match(/port=(\d+)/);
    if (match) return Number(match[1]);
    await new Promise((resolveOne) => setTimeout(resolveOne, 25));
  }
  throw new Error(`session host did not become ready:\n${stdout.value}`);
}

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await new Promise<void>((resolveOne) =>
      child!.once("exit", () => resolveOne()),
    );
  }
  child = null;
});

describe("renderer-free session host", () => {
  it("fails clearly when no session capability is supplied", async () => {
    child = spawn(process.execPath, [HOST, "--port=0"], {
      env: {
        ...process.env,
        CLAUDE_EMOTE_CAPABILITY_TOKEN: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    const exitCode = await new Promise<number>((resolveOne) =>
      child!.once("exit", (code) => resolveOne(code ?? 0)),
    );
    expect(exitCode).toBe(2);
    expect(stderr).toContain("CLAUDE_EMOTE_CAPABILITY_TOKEN");
  });

  it("publishes authenticated semantic state without terminal frames", async () => {
    const stdout = { value: "" };
    let stderr = "";
    child = spawn(
      process.execPath,
      [
        HOST,
        "--port=0",
        "--instance=session-host-test",
        `--parentPid=${process.pid}`,
      ],
      {
        env: {
          ...process.env,
          CLAUDE_EMOTE_CAPABILITY_TOKEN: TOKEN,
          CLAUDE_EMOTE_SESSION_END_GRACE_MS: "100",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.on(
      "data",
      (chunk) => (stdout.value += chunk.toString("utf8")),
    );
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString("utf8")));

    const port = await waitForReady(stdout);
    const prompt = await post(port, "/event", {
      hook_event_name: "UserPromptSubmit",
      session_id: "real-session",
      prompt: "must never reach desktop state",
    });
    expect(prompt.status).toBe(200);

    const state = await new Promise<{ status: number; body: string }>(
      (resolveOne, rejectError) => {
        const req = request(
          {
            host: "127.0.0.1",
            port,
            path: "/state",
            headers: { authorization: `Bearer ${TOKEN}` },
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
      },
    );
    expect(state.status).toBe(200);
    expect(JSON.parse(state.body)).toMatchObject({
      sessionId: "real-session",
      status: "running",
      activity: "thinking",
    });
    expect(state.body).not.toContain("must never reach");
    expect(stdout.value).not.toContain("(•");
    expect(stderr).not.toContain("renderer");

    const ended = await post(port, "/event", {
      hook_event_name: "SessionEnd",
      session_id: "real-session",
    });
    expect(ended.status).toBe(200);
    const exitCode = await new Promise<number>((resolveOne, rejectError) => {
      const timeout = setTimeout(
        () => rejectError(new Error("session host did not exit after grace")),
        2_000,
      );
      child!.once("exit", (code) => {
        clearTimeout(timeout);
        resolveOne(code ?? 0);
      });
    });
    expect(exitCode).toBe(0);
  });
});
