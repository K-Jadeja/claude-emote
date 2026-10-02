#!/usr/bin/env node
// Opens a real packaged pet, using only synthetic local events. No Claude process.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  resolveDesktopOverlay,
  buildDesktopOverlaySpawnSpec,
} from "../dist/launcher/desktop-overlay.js";
import {
  terminateOwnedAvatar,
  waitForOwnedOverlayStartup,
} from "../dist/launcher/startup.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const token = randomBytes(32).toString("base64url");
let host = null;
let overlay = null;

try {
  const command = resolveDesktopOverlay({}, process.platform, process.arch, root);
  assert.equal(command.kind, "packaged", "Run npm run overlay:package first");
  let readyOutput = "";
  let hostError = null;
  host = spawn(process.execPath, [
    join(root, "dist", "host", "session-host-process.js"),
    "--port=0", "--instance=native-smoke", `--parentPid=${process.pid}`,
  ], {
    env: { ...process.env, CLAUDE_EMOTE_CAPABILITY_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  host.once("error", (error) => { hostError = error; });
  host.stdout.on("data", (chunk) => { readyOutput += chunk.toString(); });
  host.stderr.resume();
  const deadline = Date.now() + 10_000;
  let endpoint;
  while (Date.now() < deadline) {
    if (hostError) throw hostError;
    assert.equal(host.exitCode, null, "Semantic host exited during startup");
    endpoint = readyOutput.match(/CLAUDE_EMOTE_SESSION_READY url=(\S+)/)?.[1];
    if (endpoint) break;
    await delay(50);
  }
  assert.ok(endpoint, "Semantic host did not announce readiness");
  const spec = buildDesktopOverlaySpawnSpec(command, process.env, endpoint, token, "Local smoke test");
  overlay = spawn(spec.executable, spec.args, spec.options);
  const startup = await waitForOwnedOverlayStartup(overlay, endpoint, token, 15_000);
  assert.equal(startup.status, "healthy", `Native overlay startup: ${startup.status}`);
  console.log("PASS packaged native overlay decoded its frame and connected its live stream");

  const cases = [
    [{ hook_event_name: "SessionStart" }, "greeting", "running"],
    [{ hook_event_name: "UserPromptSubmit", prompt: "Synthetic smoke" }, "thinking", "running"],
    [{ hook_event_name: "PreToolUse", tool_name: "Read" }, "reading", "running"],
    [{ hook_event_name: "PreToolUse", tool_name: "Write" }, "writing", "running"],
    [{ hook_event_name: "PreToolUse", tool_name: "Bash" }, "tooling", "running"],
    [{ hook_event_name: "MessageDisplay", turn_id: "smoke-turn", message_id: "smoke-message", index: 0, final: false, delta: "Synthetic text" }, "talking", "running"],
    [{ hook_event_name: "PermissionRequest", tool_name: "Read" }, "thinking", "needs-input"],
    [{ hook_event_name: "StopFailure" }, "failure", "blocked"],
    [{ hook_event_name: "PreCompact" }, "compacting", "running"],
    [{ hook_event_name: "Stop" }, "idle", "ready"],
    [{ hook_event_name: "SessionEnd" }, "idle", "ended"],
  ];
  let lastSequence = 0;
  for (const [event, activity, status] of cases) {
    const posted = await fetch(new URL("/event", endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...event, session_id: "native-smoke" }),
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(posted.status, 200, event.hook_event_name);
    const response = await fetch(new URL("/state", endpoint), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.deepEqual(Object.keys(state).sort(), ["activity", "sequence", "sessionId", "status", "timestamp"]);
    assert.equal(state.activity, activity, event.hook_event_name);
    assert.equal(state.status, status, event.hook_event_name);
    assert.ok(state.sequence > lastSequence);
    lastSequence = state.sequence;
    assert.equal(overlay.exitCode, null, "Native overlay exited early");
    console.log(`PASS ${event.hook_event_name}: ${activity}/${status}, private five-field state`);
    await delay(200);
  }
} finally {
  await Promise.all([terminateOwnedAvatar(overlay), terminateOwnedAvatar(host)]);
  for (const child of [overlay, host]) {
    if (child?.pid) assert.throws(() => process.kill(child.pid, 0), "Owned process survived cleanup");
  }
  console.log("PASS owned native overlay and semantic host cleaned up");
}
