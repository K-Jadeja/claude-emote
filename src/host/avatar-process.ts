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
 *   --emoteDir=...    / CLAUDE_EMOTE_EMOTE_DIR   (default: "" = automatic bundled)
 *   --parentPid=N     / CLAUDE_EMOTE_PARENT_PID  (default: null)
 *
 * Invalid CLI values throw BEFORE env fallback. Invalid env values throw
 * rather than silently falling back to defaults.
 *
 * Phase 6: emote-set selection
 *   1. Parse options. A blank emoteDir means "automatic bundled".
 *   2. Resolve the renderer kind (ascii vs image) WITHOUT loading frames.
 *   3. Choose the effective emote directory:
 *        - automatic → bundled dir matching the renderer kind
 *        - custom    → user-supplied path, preserved verbatim
 *   4. Validate compatibility. On failure, print one stderr line and
 *      exit nonzero without binding a server or printing READY.
 *   5. Construct the renderer and wire the host (Phase 5 path).
 *   6. Force a real initial frame (idle) and verify the renderer has a
 *      non-null current frame BEFORE starting the server.
 *   7. Bind the server and print CLAUDE_EMOTE_READY.
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
import {
  createRenderer,
  resolveRendererKind,
} from "../adapters/renderer-factory.js";
import { StandaloneRenderHost } from "../adapters/standalone-render-host.js";
import { detectTerminalName } from "../core/terminal.js";
import { setDebug } from "../core/log.js";
import type { AvatarReaction } from "../claude/event-mapper.js";
import {
  resolveEmoteSelection,
  type EmoteSelection,
} from "../shared/emote-selection.js";
import { validateEmoteDirectory } from "../shared/emote-validation.js";
import type { RendererKind } from "../shared/emote-validation.js";
import { PACKAGE_ROOT } from "../shared/project-paths.js";
import { loadAvatarRuntimeConfig } from "./runtime-config.js";

/**
 * Phase 6: wait for the renderer to produce a usable initial frame.
 * Bounded: at most maxTicks ticks on the macrotask queue. Returns true
 * if a non-null, non-empty frame is available. Never adds a polling
 * interval.
 */
async function waitForInitialFrame(
  getFrame: () => unknown,
  maxTicks = 10,
): Promise<boolean> {
  for (let i = 0; i < maxTicks; i++) {
    const f = getFrame() as
      | null
      | undefined
      | { kind?: string; lines?: string[]; sequence?: string };
    if (f == null) {
      await new Promise<void>((r) => setImmediate(r));
      continue;
    }
    if (f.kind === "text") {
      if (Array.isArray(f.lines) && f.lines.some((l) => l.length > 0)) {
        return true;
      }
    } else if (f.kind === "image") {
      if (typeof f.sequence === "string" && f.sequence.length > 0) {
        return true;
      }
    } else if (f.kind === "placeholder") {
      if (Array.isArray(f.lines) && f.lines.some((l) => l.length > 0)) {
        return true;
      }
    } else {
      // Unknown frame kind — accept as long as it's truthy.
      return true;
    }
    await new Promise<void>((r) => setImmediate(r));
  }
  return false;
}

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
      `[avatar-process] instance=${instanceId} port=${port} emoteDir=${emoteDir === "" ? "<automatic>" : emoteDir} parent=${parentPid ?? "null"}\n`,
    );
  }

  // --- Load config and resolve the renderer kind BEFORE picking the
  // emote directory. This way the bundled-path policy knows whether to
  // serve ascii or image assets.
  //
  // loadAvatarRuntimeConfig() is the single production boundary that
  // calls loadLayeredConfig(PACKAGE_ROOT, projectCwd). Tests can
  // call it directly to assert the exact production layering contract.
  const projectCwd = process.cwd();
  const { config, userConfiguredTerminals } = loadAvatarRuntimeConfig(projectCwd);
  const rendererKind: RendererKind = resolveRendererKind(
    config,
    userConfiguredTerminals,
  );

  // --- Resolve the effective emote directory. ---
  const selection: EmoteSelection = resolveEmoteSelection(
    emoteDir,
    rendererKind,
  );
  config.emotes = [
    {
      model: "*",
      "emote-set": selection.directory.split(/[\\/]/).pop() ?? "default",
    },
  ];
  if (debug) {
    process.stderr.write(
      `[avatar-process] emote selection: kind=${selection.kind} dir=${selection.directory}\n`,
    );
  }

  // --- Validate the directory against the chosen renderer kind. ---
  const validation = validateEmoteDirectory(selection.directory, rendererKind);
  if (!validation.ok) {
    process.stderr.write(
      `[avatar-process] invalid emote set${
        selection.kind === "custom" ? "" : " (bundled)"
      } for ${rendererKind} renderer: ${validation.reason}\n`,
    );
    process.exit(3);
    return;
  }
  if (validation.reason && debug) {
    process.stderr.write(
      `[avatar-process] emote set warning: ${validation.reason}\n`,
    );
  }

  // --- Build the renderer with the validated directory. ---
  const { renderer, resolved, setTuiHost } = createRenderer(
    config,
    PACKAGE_ROOT,
    selection.directory,
    userConfiguredTerminals,
  );
  if (debug) {
    process.stderr.write(
      `[avatar-process] terminal=${detectTerminalName()} protocol=${resolved.protocol} multiplexer=${resolved.multiplexer ?? "(none)"}\n`,
    );
    if (resolved.warning) process.stderr.write(`[avatar-process] ${resolved.warning}\n`);
  }

  // --- Wire the host to the renderer's live frame getter (Phase 5). ---
  const host = new StandaloneRenderHost();
  host.start();
  setTuiHost(host);
  host.attachFrameSource(() => renderer.getRenderedFrame());

  // --- Construct the Animator. Force the initial idle state so the
  // renderer has a real frame BEFORE we declare readiness. ---
  const animator = new Animator(config, renderer);
  animator.transitionTo("idle");

  // --- Wait for the renderer to produce a usable initial frame. ---
  const ready = await waitForInitialFrame(() => renderer.getRenderedFrame());
  if (!ready) {
    process.stderr.write(
      `[avatar-process] renderer failed to produce an initial frame from ${selection.directory}\n`,
    );
    try { animator.clearAllTimers(); } catch {}
    try { renderer.dispose(); } catch {}
    host.shutdown();
    process.exit(4);
    return;
  }

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
      `CLAUDE_EMOTE_READY url=${server.url} instance=${instanceId} port=${server.port} parentPid=${parentPid ?? "null"} emoteDir=${selection.directory}\n`,
    );
  } catch (err) {
    process.stderr.write(
      `[avatar-process] failed to bind server: ${(err as Error).message}\n`,
    );
    process.exit(1);
  }
}

main();