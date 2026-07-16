/**
 * args.ts
 *
 * Pure argument-construction helpers used by the claude-emote launcher.
 * Kept separate from claude-emote.ts so they can be imported in unit tests
 * without triggering the full launcher orchestration.
 *
 * All Windows Terminal pane argv construction lives here and is exercised
 * by tests/unit/launcher-args.test.ts. The launcher composes the
 * avatar's normal CLI argv via buildAvatarArgv() and threads each
 * token into buildWindowsTerminalArgs() without shell-quoting.
 */

import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync as nodeExistsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
// dist/launcher/args.js → ../../ (project root)
export const PROJECT_ROOT = resolve(dirname(__filename), "..", "..");
export const DIST = join(PROJECT_ROOT, "dist");
export const AVATAR_PROCESS = join(DIST, "host", "avatar-process.js");

/** True for --version / -v. Pure. */
export function isVersionArgv(argv: string[]): boolean {
  return argv.includes("--version") || argv.includes("-v");
}

/**
 * Build the full argv for `claude`, including the plugin-dir flag.
 *
 * The plugin-dir flag is injected unless the user has already passed
 * `--plugin-dir` pointing at the same resolved path as the claude-emote
 * package root. Other `--plugin-dir` values (other plugins, vendor
 * extensions, etc.) are preserved verbatim; the claude-emote plugin dir
 * is appended after them.
 *
 * The plugin dir is always emitted as an absolute, resolved path so it
 * is independent of the current working directory at launch time.
 */
export function buildClaudeArgs(userArgs: string[], pluginDir: string): string[] {
  const resolved = resolve(pluginDir);
  const out: string[] = [];
  let injected = false;
  for (let i = 0; i < userArgs.length; i++) {
    const a = userArgs[i]!;
    out.push(a);
    if (a === "--plugin-dir" && i + 1 < userArgs.length) {
      const userPath = userArgs[++i]!;
      out.push(userPath);
      // Only suppress injection if the user already pointed at OUR plugin.
      if (resolve(userPath) === resolved) injected = true;
    } else if (a.startsWith("--plugin-dir=")) {
      const userPath = a.slice("--plugin-dir=".length);
      if (resolve(userPath) === resolved) injected = true;
    }
  }
  if (!injected) {
    out.push("--plugin-dir", resolved);
  }
  return out;
}

export interface AvatarArgvOptions {
  /** Absolute path of the avatar script. Defaults to AVATAR_PROCESS. */
  scriptPath?: string;
  port: number;
  instanceId: string;
  /**
   * Custom emote directory. When null/undefined, no --emoteDir flag
   * is emitted and the avatar process will pick its bundled default
   * based on the resolved renderer kind.
   */
  emoteDir: string | null;
  parentPid: number;
}

export function buildAvatarArgv(opts: AvatarArgvOptions): string[] {
  const script = opts.scriptPath ?? AVATAR_PROCESS;
  const out: string[] = [
    script,
    `--port=${opts.port}`,
    `--instance=${opts.instanceId}`,
  ];
  if (opts.emoteDir !== null && opts.emoteDir !== undefined) {
    out.push(`--emoteDir=${opts.emoteDir}`);
  }
  out.push(`--parentPid=${opts.parentPid}`);
  return out;
}

/**
 * Maximum fraction of the parent pane occupied by the avatar.
 * Documented as 0 < size < 1.
 */
export const DEFAULT_PANE_SIZE = 0.25;
export const MIN_PANE_SIZE = 0.01;
export const MAX_PANE_SIZE = 0.99;

export interface WindowsTerminalPaneOptions {
  /**
   * Window identifier passed as `-w`. Defaults to `"0"` which targets
   * the most recently focused / current Windows Terminal window.
   */
  windowTarget?: string;
  /** Fraction of the parent pane's width occupied by the avatar pane. */
  size?: number;
  /** Pane title shown in the Windows Terminal tab bar. */
  title?: string;
  /** Working directory for the pane. */
  workingDirectory: string;
  /** Pane executable (typically process.execPath). */
  executable: string;
  /** Arguments to pass to the pane executable. */
  executableArgs: string[];
}

/**
 * Build the documented Windows Terminal split-pane argv. Pure.
 *
 * The returned array is meant to be passed element-for-element to
 * Node's spawn() — no shell, no cmd, no single string concatenation.
 *
 * Composition (matches docs/STATE_MACHINE.md and the Phase 8 spec):
 *
 *   -w 0 split-pane -V --size <size> -d <cwd> --title <title> <executable> <args...>
 *
 * Hard rules enforced by the function (and asserted by unit tests):
 *
 *   - NEVER emit `-F`. Windows Terminal interprets `-F` as fullscreen.
 *   - Use `-w 0` to target the current / most recently used window.
 *   - Use `-V` for a vertical split (right-side pane).
 *   - Use `--size` in (0, 1) range.
 *   - Use `-d` for the pane working directory.
 *   - Use `--title` for the tab title.
 *   - Pass each argument as its own argv element.
 *   - The executable itself is the final token before its argv.
 */
export function buildWindowsTerminalArgs(
  opts: WindowsTerminalPaneOptions,
): string[] {
  const windowTarget = opts.windowTarget ?? "0";
  const size = opts.size ?? DEFAULT_PANE_SIZE;
  if (!(size > MIN_PANE_SIZE && size < MAX_PANE_SIZE)) {
    throw new Error(
      `pane size must be in (${MIN_PANE_SIZE}, ${MAX_PANE_SIZE}), got ${size}`,
    );
  }
  if (opts.workingDirectory === "") {
    throw new Error("workingDirectory must be a non-empty string");
  }
  if (opts.executable === "") {
    throw new Error("executable must be a non-empty string");
  }
  if (opts.executableArgs.some((a) => a === "")) {
    throw new Error("executableArgs must not contain empty strings");
  }
  const title = opts.title ?? "claude-emote";
  const out: string[] = [
    "-w",
    windowTarget,
    "split-pane",
    "-V",
    "--size",
    String(size),
    "-d",
    opts.workingDirectory,
    "--title",
    title,
    opts.executable,
    ...opts.executableArgs,
  ];
  if (out.includes("-F") || out.includes("-f")) {
    throw new Error("buildWindowsTerminalArgs must never emit -F/-f.");
  }
  return out;
}

/**
 * Locate the Windows Terminal executable (`wt.exe`).
 *
 * Resolution order:
 *   1. CLAUDE_EMOTE_WT_EXE test/diagnostic override.
 *   2. `%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe` (the canonical
 *      Microsoft Store install location).
 *   3. `wt.exe` / `wt` on PATH.
 *
 * Returns null when nothing is found so the caller can fall back.
 */
export function findWindowsTerminalExecutable(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  fsImpl: { existsSync: (p: string) => boolean } = { existsSync: nodeExistsSync },
): string | null {
  const existsSync = fsImpl.existsSync;
  if (env.CLAUDE_EMOTE_WT_EXE && existsSync(env.CLAUDE_EMOTE_WT_EXE)) {
    return env.CLAUDE_EMOTE_WT_EXE;
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    if (localAppData) {
      const msStore = join(localAppData, "Microsoft", "WindowsApps", "wt.exe");
      if (existsSync(msStore)) return msStore;
    }
  }
  const onPath = findExecutableOnPath("wt", platform, env.PATH, fsImpl);
  return onPath;
}

function findExecutableOnPath(
  name: string,
  platform: NodeJS.Platform,
  pathEnv: string | undefined,
  fsImpl: { existsSync: (p: string) => boolean },
): string | null {
  if (!pathEnv) return null;
  const exts = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const dirs = pathEnv.split(platform === "win32" ? ";" : ":");
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (fsImpl.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Return the substring of `haystack` that contains the first occurrence
 * of each of `flags` individually if present. Used by capability probes
 * that want to verify each flag is recognised independently (not just
 * assume lowercase -f / uppercase -F behaviour from one another).
 */
export function probeFlagsInHelpText(
  helpText: string,
  flags: readonly string[],
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const f of flags) out[f] = helpText.includes(f);
  return out;
}