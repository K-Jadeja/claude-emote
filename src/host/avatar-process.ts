#!/usr/bin/env node
/**
 * avatar-process.ts
 *
 * Standalone avatar process entry point. Owns:
 *   - one Animator (the copied upstream state machine)
 *   - one Renderer (selected by the factory)
 *   - one StandaloneRenderHost (the requestRender() adapter)
 *   - one HTTP server (avatar-server.ts) bound to 127.0.0.1
 *
 * Owns nothing about Claude Code or the launcher — it does not know
 * whether the events came from hooks, a test harness, or a manual curl.
 *
 * Environment variables:
 *   CLAUDE_EMOTE_INSTANCE_ID      — random ID, used for log correlation
 *   CLAUDE_EMOTE_PORT             — port to listen on (0 = pick one)
 *   CLAUDE_EMOTE_EMOTE_DIR        — emote set directory
 *   CLAUDE_EMOTE_DEBUG=1          — verbose stderr logging
 *   CLAUDE_EMOTE_LOG_FILE=<path>  — optional persistent log file
 *   CLAUDE_EMOTE_PARENT_PID       — parent's PID; if it disappears the
 *                                    avatar shuts down after a grace period.
 */

import { startServer, waitForHealth, type AvatarServer } from "./avatar-server.js";
import { Animator } from "../core/animator.js";
import { StandaloneRenderHost } from "../adapters/standalone-render-host.js";
import { createRenderer } from "../adapters/renderer-factory.js";
import { loadLayeredConfig } from "../core/config.js";
import { detectTerminalName } from "../core/terminal.js";
import { setDebug } from "../core/log.js";
import type { AvatarReaction } from "../claude/event-mapper.js";

const instanceId = process.env.CLAUDE_EMOTE_INSTANCE_ID ?? `local-${process.pid}`;
const port = Number(process.env.CLAUDE_EMOTE_PORT ?? 0);
const emoteDir = process.env.CLAUDE_EMOTE_EMOTE_DIR;
const parentPid = Number(process.env.CLAUDE_EMOTE_PARENT_PID ?? 0);
const debug = process.env.CLAUDE_EMOTE_DEBUG === "1";
setDebug(debug);

if (debug) {
  process.stderr.write(
    `[avatar-process] instance=${instanceId} port=${port} emoteDir=${emoteDir ?? "(default)"} parent=${parentPid}\n`,
  );
}

// --- Build the renderer -----------------------------------------------------

const extDir = process.cwd();
const { config, userConfiguredTerminals } = loadLayeredConfig(extDir, process.cwd());
if (emoteDir) {
  // Override the resolved emote-set dir with what the launcher asked for.
  config.emotes = [{ model: "*", "emote-set": emoteDir.split(/[\\/]/).pop() ?? "default" }];
}

const { renderer, resolved, setTuiHost } = createRenderer(
  config,
  extDir,
  emoteDir ?? `${extDir}/emotes/ascii`,
  userConfiguredTerminals,
);
if (debug) {
  process.stderr.write(
    `[avatar-process] terminal=${detectTerminalName()} protocol=${resolved.protocol} multiplexer=${resolved.multiplexer ?? "(none)"}\n`,
  );
  if (resolved.warning) process.stderr.write(`[avatar-process] ${resolved.warning}\n`);
}

const host = new StandaloneRenderHost();
host.start();
setTuiHost(host);

const animator = new Animator(config, renderer);

// --- HTTP server ------------------------------------------------------------

let server: AvatarServer | null = null;
let shuttingDown = false;

function onEvent(reaction: AvatarReaction, _raw: unknown): void {
  if (reaction.shutdown) {
    shutdown("session_end");
    return;
  }
  if (reaction.state) animator.transitionTo(reaction.state);
}

function onMessageDelta(content: string): void {
  animator.onTalkToken(content);
}

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (debug) process.stderr.write(`[avatar-process] shutdown: ${reason}\n`);
  try {
    animator.clearAllTimers();
  } catch {}
  try {
    renderer.dispose();
  } catch {}
  host.shutdown();
  if (server) {
    try {
      await server.close();
    } catch {}
  }
  // Give the OS a moment to flush the cursor-show bytes.
  setTimeout(() => process.exit(0), 50).unref();
}

// --- Lifecycle --------------------------------------------------------------

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  if (debug) process.stderr.write(`[avatar-process] uncaught: ${err.message}\n`);
  shutdown("uncaughtException");
});

// Parent process watcher: if the launcher dies, we don't want to leave
// a zombie avatar. Check every second; bail out if parent is gone.
if (parentPid > 0) {
  const interval = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      // Parent is gone — shut down with a small grace period.
      clearInterval(interval);
      if (debug) process.stderr.write(`[avatar-process] parent ${parentPid} disappeared\n`);
      setTimeout(() => shutdown("parent_gone"), 500).unref();
    }
  }, 1_000);
  interval.unref();
}

// Start the server and print the URL on stdout in a structured form so
// the launcher can scrape it. (We use stdout here because that's how the
// launcher reads it back; bridge contracts say stdout must be empty, but
// that's the *bridge* process, not the avatar process.)
startServer({ instanceId, port, onEvent, onMessageDisplayDelta: onMessageDelta })
  .then((s) => {
    server = s;
    // Signal readiness to the launcher.
    process.stdout.write(`CLAUDE_EMOTE_READY url=${s.url} instance=${instanceId}\n`);
  })
  .catch((err) => {
    if (debug) process.stderr.write(`[avatar-process] start failed: ${err.message}\n`);
    process.exit(1);
  });

// Diagnostic: wait briefly and confirm the health check works end-to-end.
setTimeout(() => {
  if (server) {
    waitForHealth(server.url, 1000).then((ok) => {
      if (debug) process.stderr.write(`[avatar-process] self-health: ${ok ? "ok" : "fail"}\n`);
    });
  }
}, 200).unref();
