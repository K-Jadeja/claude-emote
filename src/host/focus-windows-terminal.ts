/**
 * focus-windows-terminal.ts
 *
 * Best-effort "focus the originating Windows Terminal window" resolver.
 *
 * The launcher inherits `WT_SESSION` from the user's shell (it is a
 * random GUID assigned by Windows Terminal to each WT window). The
 * launcher passes that GUID to the host via `CLAUDE_EMOTE_WT_WINDOW_ID`.
 * The focuser uses it as the `-w <windowId>` arg to `wt.exe focus-tab`.
 *
 * We intentionally do NOT probe `wt.exe list-windows --output json`
 * because:
 *   - The command was only added in WT 1.22 (May 2024). Users on older
 *     WT builds get "The system cannot find the file specified" and a
 *     silent empty stdout, which would make the resolver a permanent
 *     no-op.
 *   - Older WT versions still accept `focus-tab --target <N> -w <guid>`
 *     reliably. We trade a touch of pane precision (we always target
 *     tab 0) for a much wider compatibility surface.
 *
 * Hard rules:
 *   - Uses child_process.execFile with `shell: false`. Never the shell.
 *   - On non-`win32`, with no `wtExecutable`, or with no `wtWindowId`,
 *     focus() is a permanent silent no-op. No I/O is ever attempted.
 *   - Concurrent focus() calls share a single in-flight promise.
 *   - The module is a pure value with an injectable `execImpl`. Tests
 *     pass a vitest mock; production callers use the real execFile.
 */

import { execFile as defaultExecFile } from "node:child_process";
import type { ExecException } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(defaultExecFile);

export type FocusOutcome =
  | { kind: "focused"; windowId: string; tabIndex: number }
  | { kind: "best-effort-noop"; reason: string };

export interface WindowsTerminalFocus {
  /** Best-effort focus of the WT window. Always resolves; never throws. */
  focus(): Promise<FocusOutcome>;
  /** Always false in this implementation; retained for API stability. */
  hasResolved(): boolean;
  /** No-op; retained for API stability. */
  invalidate(): void;
}

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

export type ExecFileFn = (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<ExecFileResult>;

export interface WindowsTerminalFocusOptions {
  /**
   * Resolved `wt.exe` path. When `null` or empty, the focuser is
   * permanently a no-op (host was started outside Windows Terminal
   * or `wt.exe` could not be located).
   */
  wtExecutable: string | null;
  /**
   * WT window GUID (the `WT_SESSION` value the launcher inherited from
   * the user's shell). When `null` or empty, the focuser is a permanent
   * no-op — we refuse to call `wt.exe focus-tab -w <empty>` because
   * that would open a new WT window, which is destructive.
   */
  wtWindowId: string | null;
  /** Test seam. Defaults to `node:child_process.execFile`. */
  execImpl?: ExecFileFn;
  /** Test seam. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Diagnostic sink. Receives only the FocusOutcome summary. */
  diagnostics?: (line: string) => void;
  /** Timeout for the `focus-tab` call. Default 2_000 ms. */
  focusTimeoutMs?: number;
}

const DEFAULT_FOCUS_TIMEOUT_MS = 2_000;
const DEFAULT_TAB_INDEX = 0;

export function createWindowsTerminalFocus(
  opts: WindowsTerminalFocusOptions,
): WindowsTerminalFocus {
  const platform = opts.platform ?? process.platform;
  const diagnostics = opts.diagnostics ?? ((): void => {});
  const execImpl = opts.execImpl ?? defaultExecFileWrapper;

  if (platform !== "win32") {
    return permanentNoOp("not-windows");
  }
  if (opts.wtExecutable === null || opts.wtExecutable === "") {
    return permanentNoOp("wt-not-found");
  }
  if (opts.wtWindowId === null || opts.wtWindowId === "") {
    return permanentNoOp("not-in-windows-terminal");
  }

  const wtPath = opts.wtExecutable;
  const wtWindowId = opts.wtWindowId;
  const focusTimeoutMs = opts.focusTimeoutMs ?? DEFAULT_FOCUS_TIMEOUT_MS;

  let inflight: Promise<FocusOutcome> | null = null;

  async function doFocus(): Promise<FocusOutcome> {
    try {
      await execImpl(
        wtPath,
        [
          "focus-tab",
          "--target",
          String(DEFAULT_TAB_INDEX),
          "-w",
          wtWindowId,
        ],
        { timeout: focusTimeoutMs },
      );
      return {
        kind: "focused",
        windowId: wtWindowId,
        tabIndex: DEFAULT_TAB_INDEX,
      };
    } catch (err) {
      return {
        kind: "best-effort-noop",
        reason: describeExecError(err),
      };
    }
  }

  async function focus(): Promise<FocusOutcome> {
    if (inflight !== null) return inflight;
    const promise = (async (): Promise<FocusOutcome> => {
      try {
        return await doFocus();
      } finally {
        inflight = null;
      }
    })();
    inflight = promise;
    diagnostics(
      `[focus-windows-terminal] focus-tab -w <redacted> --target ${DEFAULT_TAB_INDEX}\n`,
    );
    return promise;
  }

  return {
    focus,
    hasResolved: () => false,
    invalidate: () => {},
  };
}

function permanentNoOp(reason: string): WindowsTerminalFocus {
  return {
    focus: async () => ({ kind: "best-effort-noop", reason }),
    hasResolved: () => false,
    invalidate: () => {},
  };
}

function describeExecError(err: unknown): string {
  if (err instanceof Error) {
    const e = err as ExecException;
    if (typeof e.code === "number") return `exit ${e.code}`;
    if (typeof e.code === "string") return e.code;
    if (e.killed) return "killed";
    return err.message;
  }
  return String(err);
}

async function defaultExecFileWrapper(
  file: string,
  args: string[],
  options: { timeout: number },
): Promise<ExecFileResult> {
  // Mirror the launcher's test seam: a `.cjs` / `.js` / `.mjs` path
  // is routed through the current node binary. The real `wt.exe` is
  // always a real .exe on Windows so this only affects tests and
  // local debug runs.
  const isNodeScript = /\.(cjs|js|mjs)$/i.test(file);
  const exe = isNodeScript ? process.execPath : file;
  const argv = isNodeScript ? [file, ...args] : args;
  const result = await execFileP(exe, argv, {
    timeout: options.timeout,
    shell: false,
    windowsHide: true,
    encoding: "utf8",
  });
  return {
    stdout:
      typeof result.stdout === "string"
        ? result.stdout
        : Buffer.from(result.stdout).toString("utf8"),
    stderr:
      typeof result.stderr === "string"
        ? result.stderr
        : Buffer.from(result.stderr).toString("utf8"),
  };
}