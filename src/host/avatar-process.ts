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
 *   CLAUDE_EMOTE_VISUAL_PANE=1    — Phase 10.1: the launcher passes
 *                                   this only to the WT pane child;
 *                                   all non-frame writes are
 *                                   suppressed from stdout / stderr
 *                                   and readiness is observed via
 *                                   /health instead of a READY
 *                                   marker. Fatal startup errors may
 *                                   still print one concise line.
 */

import { startServer, type AvatarServer } from "./avatar-server.js";
import {
  parseAvatarProcessOptions,
  AvatarParseError,
} from "./avatar-args.js";
import { resolveRendererKind } from "../adapters/renderer-factory.js";
import { detectTerminalName } from "../core/terminal.js";
import { setDebug } from "../core/log.js";
import type { AvatarReaction } from "../claude/event-mapper.js";
import {
  createAvatarStateController,
  type AvatarStateController,
} from "./avatar-state-controller.js";
import {
  resolveEmoteSelection,
  type EmoteSelection,
} from "../shared/emote-selection.js";
import { validateEmoteDirectory } from "../shared/emote-validation.js";
import type { RendererKind } from "../shared/emote-validation.js";
import { BUNDLED_ASCII_EMOTE_DIR, PACKAGE_ROOT } from "../shared/project-paths.js";
import { loadAvatarRuntimeConfig } from "./runtime-config.js";
import {
  startRendererRuntimeWithFallback,
  buildProductionRendererStartupDeps,
  type RendererStartupDeps,
} from "./renderer-startup.js";
import {
  createAvatarOutputPolicy,
  type AvatarOutputPolicy,
} from "./output-policy.js";

async function main(): Promise<void> {
  const debug = process.env.CLAUDE_EMOTE_DEBUG === "1";
  setDebug(debug);

  // --- Phase 10.1 visual-pane contract.
  //
  // When the launcher spawned this avatar inside a Windows
  // Terminal pane it passes CLAUDE_EMOTE_VISUAL_PANE=1 to the
  // pane child. The writing surface then becomes an exclusive
  // render area: every non-frame write (READY, fallback warning,
  // debug diagnostics, server event logs, port / instance /
  // emote-directory messages) is suppressed from stdout / stderr
  // so the pane stays clean. Readiness is observed through
  // /health (the launcher already polls it). The single fatal
  // startup path may still write one concise line because no
  // usable renderer exists in that case.
  const visualPane = process.env.CLAUDE_EMOTE_VISUAL_PANE === "1";
  const logFile = process.env.CLAUDE_EMOTE_LOG_FILE;
  const policy: AvatarOutputPolicy = createAvatarOutputPolicy({
    visualPane,
    debug,
    logFile,
  });

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
    policy.writeFatal(`[avatar-process] invalid configuration: ${msg}\n`);
    process.exit(2);
    return;
  }

  const { instanceId, port, emoteDir, parentPid } = options;

  policy.writeDiagnostic(
    `[avatar-process] instance=${instanceId} port=${port} emoteDir=${emoteDir === "" ? "<automatic>" : emoteDir} parent=${parentPid ?? "null"}\n`,
  );

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
  policy.writeDiagnostic(
    `[avatar-process] emote selection: kind=${selection.kind} dir=${selection.directory}\n`,
  );

  // --- Validate the directory against the chosen renderer kind. ---
  const validation = validateEmoteDirectory(selection.directory, rendererKind);
  if (!validation.ok) {
    policy.writeFatal(
      `[avatar-process] invalid emote set${
        selection.kind === "custom" ? "" : " (bundled)"
      } for ${rendererKind} renderer: ${validation.reason}\n`,
    );
    process.exit(3);
    return;
  }
  if (validation.reason) {
    policy.writeDiagnostic(
      `[avatar-process] emote set warning: ${validation.reason}\n`,
    );
  }

  // --- Bundled ASCII fallback (Phase 10 / Defect B).
  //
  // Construction of the renderer, host, animator, and initial-frame
  // readiness check, AND the fallback policy itself, lives in
  // renderer-startup.ts. This file delegates the decision so the
  // production policy is exercised by exactly one orchestrator.
  //
  // We do NOT mutate the caller's shared `config` object across
  // attempts: attemptRendererStartup operates on a per-attempt clone.
  const deps: RendererStartupDeps = buildProductionRendererStartupDeps(PACKAGE_ROOT);

  const started = await startRendererRuntimeWithFallback({
    config,
    selection,
    userConfiguredTerminals,
    deps,
    bundledAsciiDirectory: BUNDLED_ASCII_EMOTE_DIR,
    validateEmoteDirectory,
    onFallbackWarning: (msg) => policy.writeWarning(msg),
  });

  if (!started.ok) {
    policy.writeFatal(`[avatar-process] ${started.reason}\n`);
    process.exit(4);
    return;
  }

  const { renderer, resolved, host, animator, selection: chosenSelection } =
    started.runtime;
  policy.writeDiagnostic(
    `[avatar-process] terminal=${detectTerminalName()} protocol=${resolved.protocol} multiplexer=${resolved.multiplexer ?? "(none)"}\n`,
  );
  if (resolved.warning) {
    policy.writeWarning(`[avatar-process] ${resolved.warning}\n`);
  }

  // --- Phase 10.1: one-time visual-pane surface initialization.
  //
  // The host has already scheduled its first redraw (inside
  // attemptRendererStartup → attachFrameSource). We mark the host
  // for a one-time clear-pane + cursor-home so the first redraw
  // erases any pre-existing pane content (the wrap-prone
  // diagnostic rows from earlier startup steps) before drawing the
  // frame. Subsequent redraws use the normal erase-N-lines path;
  // the renderer owns the frame area from then on.
  if (visualPane) {
    host.initializeVisualSurface();
  }

  // --- State controller (Phase 7) -------------------------------------------
  //
  // Single owner of avatar-state priority. The controller decides
  // whether each AvatarReaction's state and talk token should reach
  // the Animator. The avatar process itself must not call
  // animator.transitionTo() or animator.onTalkToken() from event
  // callbacks. The single exception is the startup transition to
  // "idle" below, which establishes the initial visible state
  // before the controller is constructed.

  const stateController: AvatarStateController = createAvatarStateController({
    animator: {
      transitionTo: (state) => animator.transitionTo(state),
      onTalkToken: (token) => animator.onTalkToken(token),
      setHoldNextState: (state) => animator.setHoldNextState(state),
    },
    onShutdown: () => shutdown("session_end"),
  });

  // --- HTTP server -----------------------------------------------------------

  let server: AvatarServer | null = null;
  let shuttingDown = false;

  function onEvent(reaction: AvatarReaction, _raw: unknown): void {
    stateController.handle(reaction);
  }

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    policy.writeDiagnostic(`[avatar-process] shutdown: ${reason}\n`);
    try {
      stateController.shutdown();
    } catch {}
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
    policy.writeDiagnostic(`[avatar-process] uncaught: ${err.message}\n`);
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
        policy.writeDiagnostic(
          `[avatar-process] parent ${parentPid} disappeared\n`,
        );
        setTimeout(() => shutdown("parent_gone"), 500).unref();
      }
    }, 1_000);
    interval.unref();
  }

  // Start the server. The READY marker includes the actual bound port so
  // a --port=0 launch is observable end-to-end. In visual-pane mode the
  // policy suppresses the READY marker — readiness is observed through
  // /health (which the launcher polls), not through stdout parsing.
  try {
    server = await startServer({
      instanceId,
      port,
      onEvent,
      policy,
      // Note: avatar-server.ts previously called a separate
      // onMessageDisplayDelta callback. Phase 7 routes talk tokens
      // through the AvatarReaction.talkToken field and the state
      // controller decides when to forward them. AvatarStateController
      // is the single owner of Animator.onTalkToken() calls.
    });
    policy.writeReady(
      `CLAUDE_EMOTE_READY url=${server.url} instance=${instanceId} port=${server.port} parentPid=${parentPid ?? "null"} emoteDir=${chosenSelection.directory}\n`,
    );
  } catch (err) {
    policy.writeFatal(
      `[avatar-process] failed to bind server: ${(err as Error).message}\n`,
    );
    process.exit(1);
  }
}

main();