#!/usr/bin/env node
/**
 * Renderer-free per-session host used by the native desktop pet.
 *
 * This process owns semantic hook mapping, the authoritative state snapshot,
 * authenticated SSE delivery, parent-PID cleanup, and a bounded SessionEnd
 * grace period. It intentionally imports no renderer, terminal detector,
 * artwork loader, Animator, or Chafa integration.
 */

import {
  AvatarParseError,
  parseAvatarProcessOptions,
} from "./avatar-args.js";
import { startServer, type AvatarServer } from "./avatar-server.js";
import { createAvatarOutputPolicy } from "./output-policy.js";
import { createPetSessionStateTracker } from "./pet-session-state-tracker.js";
import type { AvatarReaction } from "../claude/event-mapper.js";
import { requireSessionCapability } from "../shared/session-capability.js";
import { createWindowsTerminalFocus } from "./focus-windows-terminal.js";

const DEFAULT_SESSION_END_GRACE_MS = 2_000;

function readSessionEndGraceMs(env: NodeJS.ProcessEnv): number {
  const raw = env.CLAUDE_EMOTE_SESSION_END_GRACE_MS;
  if (raw === undefined) return DEFAULT_SESSION_END_GRACE_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 10_000) {
    throw new Error(
      "CLAUDE_EMOTE_SESSION_END_GRACE_MS must be an integer in [0, 10000]",
    );
  }
  return parsed;
}

async function main(): Promise<void> {
  const debug = process.env.CLAUDE_EMOTE_DEBUG === "1";
  const policy = createAvatarOutputPolicy({
    visualPane: false,
    debug,
    logFile: process.env.CLAUDE_EMOTE_LOG_FILE,
  });

  let options;
  let capabilityToken: string;
  let sessionEndGraceMs: number;
  try {
    options = parseAvatarProcessOptions(process.argv.slice(2), process.env);
    capabilityToken = requireSessionCapability(
      process.env.CLAUDE_EMOTE_CAPABILITY_TOKEN,
    );
    sessionEndGraceMs = readSessionEndGraceMs(process.env);
  } catch (error) {
    const message =
      error instanceof AvatarParseError || error instanceof Error
        ? error.message
        : String(error);
    policy.writeFatal(`[session-host] invalid configuration: ${message}\n`);
    process.exit(2);
    return;
  }

  const { instanceId, port, parentPid } = options;
  const sessionState = createPetSessionStateTracker(instanceId);
  // The launcher inherits WT_SESSION from the user's shell and passes
  // it through as CLAUDE_EMOTE_WT_WINDOW_ID. The host uses that GUID
  // as the `-w <id>` arg to `wt.exe focus-tab`. Without a known
  // window id, the focuser refuses to call `wt.exe` because `-w 0`
  // would open a new window rather than focus one.
  const wtExecutableRaw = process.env.CLAUDE_EMOTE_WT_EXE?.trim() ?? "";
  const wtExecutable = wtExecutableRaw === "" ? null : wtExecutableRaw;
  const wtWindowIdRaw = process.env.CLAUDE_EMOTE_WT_WINDOW_ID?.trim() ?? "";
  const wtWindowId = wtWindowIdRaw === "" ? null : wtWindowIdRaw;
  const focuser = createWindowsTerminalFocus({
    wtExecutable,
    wtWindowId,
    diagnostics: (line) => policy.writeDiagnostic(line),
  });
  let server: AvatarServer | null = null;
  let shuttingDown = false;
  let sessionEndTimer: NodeJS.Timeout | null = null;
  let parentWatchTimer: NodeJS.Timeout | null = null;

  async function shutdown(reason: string, exitCode = 0): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    policy.writeDiagnostic(`[session-host] shutdown: ${reason}\n`);
    if (sessionEndTimer) clearTimeout(sessionEndTimer);
    if (parentWatchTimer) clearInterval(parentWatchTimer);
    if (server) {
      try {
        await server.close();
      } catch {
        // The process is already terminating. There is no state to repair.
      }
    }
    setTimeout(() => process.exit(exitCode), 25).unref();
  }

  function onEvent(reaction: AvatarReaction, raw: unknown): void {
    sessionState.apply(raw, reaction);
    if (!reaction.shutdown || sessionEndTimer) return;
    sessionEndTimer = setTimeout(() => {
      void shutdown("session_end");
    }, sessionEndGraceMs);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (error) => {
    policy.writeFatal(`[session-host] uncaught: ${error.message}\n`);
    void shutdown("uncaughtException", 1);
  });

  if (parentPid !== null) {
    parentWatchTimer = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        void shutdown("parent_gone");
      }
    }, 1_000);
    parentWatchTimer.unref();
  }

  try {
    server = await startServer({
      instanceId,
      port,
      onEvent,
      sessionState,
      capabilityToken,
      policy,
      focuser,
    });
    policy.writeReady(
      `CLAUDE_EMOTE_SESSION_READY url=${server.url} instance=${instanceId} port=${server.port} parentPid=${parentPid ?? "null"}\n`,
    );
  } catch (error) {
    policy.writeFatal(
      `[session-host] failed to bind server: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exit(1);
  }
}

void main();
