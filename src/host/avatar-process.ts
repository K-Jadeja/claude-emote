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
 * Configuration (CLI > env > default; see avatar-args.ts):
 *   --port=1234       / CLAUDE_EMOTE_PORT        (default: 0 = OS picks)
 *   --instance=...    / CLAUDE_EMOTE_INSTANCE_ID (default: "standalone")
 *   --emoteDir=...    / CLAUDE_EMOTE_EMOTE_DIR   (default: ${cwd}/emotes/ascii)
 *   --parentPid=N     / CLAUDE_EMOTE_PARENT_PID  (default: null)
 *
 * Invalid CLI values throw BEFORE env fallback. Invalid env values throw
 * rather than silently falling back to defaults.
 *
 * Environment variables:
 *   CLAUDE_EMOTE_DEBUG=1          — verbose stderr logging
 *   CLAUDE_EMOTE_LOG_FILE=<path>  — optional persistent log file
 */

import { startServer, type AvatarServer } from "./avatar-server.js";
import {
  parseAvatarProcessOptions,
  AvatarParseError,
} from "./avatar-args.js";
import { Animator } from "../core/animator.js";
import { StandaloneRenderHost } from "../adapters/standalone-render-host.js";
import { createRenderer } from "../adapters/renderer-factory.js";
import { loadLayeredConfig } from "../core/config.js";
import { detectTerminalName } from "../core/terminal.js";
import { setDebug } from "../core/log.js";
import type { AvatarReaction } from "../claude/event-mapper.js";

async function main(): Promise<void> {
  const debug = process.env.CLAUDE_EMOTE_DEBUG === "1";
  setDebug(debug);

  // --- Parse configuration first. On failure, exit cleanly without
  // touching the renderer or binding an HTTP server. ---
  let options;
  try {
    options = parseAvatarProcessOptions(process.argv.slice(2), process.env);
  } catch (err) {
    const msg =
      err instanceof AvatarParseError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    process.stderr.write(`[avatar-process] invalid configuration: ${msg}\n`);
    process.exit(2);
    return;
  }

  const { instanceId, port, emoteDir, parentPid } = options;

  if (debug) {
    process.stderr.write(
      `[avatar-process] instance=${instanceId} port=${port} emoteDir=${emoteDir} parent=${parentPid ?? "null"}\n`,
    );
  }

  // --- Build the renderer ----------------------------------------------------

  const extDir = process.cwd();
  const { config, userConfiguredTerminals } = loadLayeredConfig(
    extDir,
    process.cwd(),
  );
  // The parser already produced a resolved emoteDir (never null).
  config.emotes = [
    { model: "*", "emote-set": emoteDir.split(/[\\/]/).pop() ?? "default" },
  ];

  const { renderer, resolved, setTuiHost } = createRenderer(
    config,
    extDir,
    emoteDir,
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
  // P5: connect the renderer's current-frame getter to the host. The host
  // pulls the latest frame at every redraw, so renderer-driven
  // requestRender() calls actually draw the newest frame instead of a
  // one-time snapshot.
  host.attachFrameSource(() => renderer.getRenderedFrame());

  const animator = new Animator(config, renderer);

  // --- HTTP server -----------------------------------------------------------

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
    setTimeout(() => process.exit(0), 50).unref();
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    if (debug) process.stderr.write(`[avatar-process] uncaught: ${err.message}\n`);
    shutdown("uncaughtException");
  });

  // Parent-PID watcher. The parser returns null when no parent was
  // supplied, in which case we skip the watcher entirely.
  if (parentPid !== null) {
    const interval = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        clearInterval(interval);
        if (debug) {
          process.stderr.write(
            `[avatar-process] parent ${parentPid} disappeared\n`,
          );
        }
        setTimeout(() => shutdown("parent_gone"), 500).unref();
      }
    }, 1_000);
    interval.unref();
  }

  // Start the server. The READY marker includes the actual bound port so
  // a --port=0 launch is observable end-to-end.
  try {
    server = await startServer({
      instanceId,
      port,
      onEvent,
      onMessageDisplayDelta: onMessageDelta,
    });
    process.stdout.write(
      `CLAUDE_EMOTE_READY url=${server.url} instance=${instanceId} port=${server.port} parentPid=${parentPid ?? "null"}\n`,
    );
  } catch (err) {
    process.stderr.write(
      `[avatar-process] failed to bind server: ${(err as Error).message}\n`,
    );
    process.exit(1);
  }
}

main();