/**
 * output-policy.ts
 *
 * Phase 10.1: one small abstraction that owns every non-frame write
 * the avatar process makes to stdout / stderr. Production callers
 * construct a single policy at the top of avatar-process.ts and
 * thread it into the renderer-startup path and avatar-server. No
 * other code may write to stdout / stderr for diagnostics; the
 * policy is the single seam.
 *
 * Two output modes:
 *
 *   - "normal" (the default): everything is forwarded to stdout /
 *     stderr. READY is printed on stdout. Warnings and diagnostics
 *     land on stderr. This is what tests, attached fallback, and
 *     the package validation suite rely on.
 *
 *   - "visual-pane" (CLAUDE_EMOTE_VISUAL_PANE=1): the writing
 *     surface is an exclusive render area inside a Windows Terminal
 *     pane. Non-frame operational text — READY, fallback warning,
 *     debug diagnostics, server event logs, port/instance/emoteDir
 *     messages — would be painted onto that surface, wrap across
 *     many narrow rows, and then be partially overwritten by the
 *     renderer's cursor-relative redraw. The visible result is the
 *     corruption pattern observed on the real WT machine.
 *
 *     In visual-pane mode the policy suppresses every non-frame
 *     write from stdout / stderr. When CLAUDE_EMOTE_LOG_FILE is
 *     configured, suppressed diagnostics still go to the log file.
 *     Readiness is observed exclusively through /health, which the
 *     launcher already polls. Fatal startup errors are allowed to
 *     print exactly one concise line because no usable renderer
 *     exists in that case.
 *
 *     The visual surface is initialized ONCE on the first render
 *     via initializeVisualSurface(): a clear-pane + cursor-home
 *     sequence so any pre-existing text in the pane is erased before
 *     the renderer takes ownership. After that the renderer manages
 *     its own frame area.
 *
 * The policy is stateless with respect to the host environment; the
 * same construction works in unit tests (writeable log file is
 * optional), in subprocess smoke tests, and in the real installed
 * avatar. All public methods are no-throw best-effort.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { clearPane } from "../adapters/terminal-output.js";

/**
 * Public surface of the policy. Five responsibilities:
 *
 *   - writeDiagnostic: debug-only text (instance, port, terminal name,
 *     avatar-server event logs, etc.)
 *   - writeWarning:    non-fatal user-visible warnings (one line each)
 *   - writeReady:      the CLAUDE_EMOTE_READY marker
 *   - writeFatal:      fatal startup errors
 *   - initializeVisualSurface: one-time clear+home before first frame
 */
export interface AvatarOutputPolicy {
  /**
   * Emit a diagnostic line. In visual-pane mode this is suppressed
   * from stdout / stderr unless a log file is configured. In normal
   * mode the line is sent to stderr when `debug` is true and
   * silently dropped otherwise. Caller is responsible for the
   * trailing newline.
   */
  writeDiagnostic(message: string): void;
  /**
   * Emit a non-fatal warning. Suppressed in visual-pane mode unless
   * a log file is configured. In normal mode the line is sent to
   * stderr unconditionally. Caller is responsible for the trailing
   * newline.
   */
  writeWarning(message: string): void;
  /**
   * Emit the readiness marker. Suppressed in visual-pane mode unless
   * a log file is configured. In normal mode the line is sent to
   * stdout unconditionally. Caller is responsible for the trailing
   * newline.
   */
  writeReady(message: string): void;
  /**
   * Emit a fatal startup error. Allowed exactly once per visual-pane
   * session because no usable renderer exists. In normal mode the
   * line is sent to stderr. Caller is responsible for the trailing
   * newline.
   */
  writeFatal(message: string): void;
  /**
   * Initialize the visual pane surface: clear the pane and home the
   * cursor. Idempotent across calls. No-op in normal mode.
   */
  initializeVisualSurface(): void;
  /**
   * True when the visual-pane contract applies. Tests use this to
   * assert which mode they exercised.
   */
  readonly visualPane: boolean;
}

export interface CreateAvatarOutputPolicyOptions {
  /**
   * When true, the policy treats its writing surface as an
   * exclusive render area. Non-frame writes are suppressed from
   * stdout / stderr unless a log file is configured. Visual-pane
   * mode also enables initializeVisualSurface().
   */
  visualPane: boolean;
  /**
   * When true, diagnostic writes (writeDiagnostic) are emitted in
   * normal mode. In visual-pane mode this flag is irrelevant
   * because diagnostics are suppressed entirely.
   */
  debug: boolean;
  /**
   * Optional persistent log path. When set, every suppressed write
   * is appended to the file so developers can still observe what
   * the avatar process is doing during a real Windows Terminal
   * run, without paying the visual-corruption cost.
   */
  logFile?: string;
  /**
   * Optional sinks for stdout / stderr. When provided the policy
   * routes its writes through the sinks instead of the real
   * process streams. Used by unit tests to assert the exact
   * bytes the policy emits. When omitted, the policy uses
   * `process.stdout.write` / `process.stderr.write` directly.
   */
  sinks?: {
    stdout?: (chunk: string) => void;
    stderr?: (chunk: string) => void;
  };
}

function safeAppendFile(path: string, line: string): void {
  try {
    appendFileSync(path, line);
  } catch {
    // Best-effort. Logging must never crash the avatar process.
  }
}

function ensureLogFile(path: string): void {
  try {
    writeFileSync(path, "", { flag: "a" });
  } catch {
    // ignore — next appendFileSync will retry or also fail.
  }
}

/**
 * Construct an output policy. Pure with respect to the runtime
 * environment except for the actual file and stream side effects,
 * which are explicit and observable.
 */
export function createAvatarOutputPolicy(
  opts: CreateAvatarOutputPolicyOptions,
): AvatarOutputPolicy {
  const visualPane = !!opts.visualPane;
  const debug = !!opts.debug;
  const logFile = typeof opts.logFile === "string" && opts.logFile !== ""
    ? opts.logFile
    : null;
  if (logFile) ensureLogFile(logFile);

  const stdoutSink = typeof opts.sinks?.stdout === "function"
    ? opts.sinks.stdout
    : null;
  const stderrSink = typeof opts.sinks?.stderr === "function"
    ? opts.sinks.stderr
    : null;

  const writeToStdout = (chunk: string): void => {
    if (stdoutSink) {
      stdoutSink(chunk);
      return;
    }
    try {
      process.stdout.write(chunk);
    } catch {
      // ignore
    }
  };
  const writeToStderr = (chunk: string): void => {
    if (stderrSink) {
      stderrSink(chunk);
      return;
    }
    try {
      process.stderr.write(chunk);
    } catch {
      // ignore
    }
  };

  const writeVisualPneFatalOnce = (() => {
    let written = false;
    return (line: string): void => {
      if (written) return;
      written = true;
      // In visual-pane mode a fatal message may still be shown
      // because no renderer exists to suppress it. Log it first so
      // even if stdout / stderr are torn down the record survives.
      if (logFile) safeAppendFile(logFile, line);
      writeToStderr(line);
    };
  })();

  let surfaceInitialized = false;

  return {
    visualPane,

    writeDiagnostic(message: string): void {
      if (visualPane) {
        if (logFile) safeAppendFile(logFile, message);
        return;
      }
      if (!debug) return;
      writeToStderr(message);
    },

    writeWarning(message: string): void {
      if (visualPane) {
        if (logFile) safeAppendFile(logFile, message);
        return;
      }
      writeToStderr(message);
    },

    writeReady(message: string): void {
      if (visualPane) {
        if (logFile) safeAppendFile(logFile, message);
        return;
      }
      writeToStdout(message);
    },

    writeFatal(message: string): void {
      if (visualPane) {
        writeVisualPneFatalOnce(message);
        return;
      }
      writeToStderr(message);
    },

    initializeVisualSurface(): void {
      if (!visualPane) return;
      if (surfaceInitialized) return;
      surfaceInitialized = true;
      // We must emit the clear sequence through the same sink that
      // owns the visual surface — normally process.stdout via the
      // terminal-output module's active stream. Tests that swap
      // stdoutSink must also route through clearPane() via
      // setOutputStream(). For test simplicity we let the
      // terminal-output module pick its own active stream here; in
      // practice tests exercise the policy directly via the
      // buildRenderHost/visual-pane flow rather than calling
      // initializeVisualSurface in unit tests.
      clearPane();
    },
  };
}
