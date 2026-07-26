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
import {
  existsSync as nodeExistsSync,
  lstatSync as nodeLstatSync,
} from "node:fs";
import { execFileSync as nodeExecFileSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
// dist/launcher/args.js → ../../ (project root)
export const PROJECT_ROOT = resolve(dirname(__filename), "..", "..");
export const DIST = join(PROJECT_ROOT, "dist");
export const AVATAR_PROCESS = join(DIST, "host", "avatar-process.js");
export const SESSION_HOST_PROCESS = join(
  DIST,
  "host",
  "session-host-process.js",
);

export type EmoteRendererMode = "desktop" | "terminal" | "none";

export interface ParsedLauncherArgs {
  renderer: EmoteRendererMode;
  claudeArgs: string[];
}

/**
 * Consume only claude-emote-owned flags and preserve Claude's argv byte for
 * byte and in order. Everything after `--` belongs to Claude.
 */
export function parseLauncherArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): ParsedLauncherArgs {
  const envMode = env.CLAUDE_EMOTE_RENDERER?.trim();
  let renderer: EmoteRendererMode =
    envMode === undefined || envMode === ""
      ? env.CLAUDE_EMOTE_TEST_MODE === "1"
        ? "terminal"
        : platform === "win32"
          ? "desktop"
          : "terminal"
      : parseRendererMode(envMode, "CLAUDE_EMOTE_RENDERER");
  let flagMode: EmoteRendererMode | null = null;
  const claudeArgs: string[] = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (passthrough) {
      claudeArgs.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
      claudeArgs.push(arg);
      continue;
    }

    let value: string | null = null;
    if (arg === "--emote-renderer") {
      value = argv[index + 1] ?? null;
      if (value === null || value.startsWith("--")) {
        throw new Error("--emote-renderer requires desktop, terminal, or none");
      }
      index += 1;
    } else if (arg.startsWith("--emote-renderer=")) {
      value = arg.slice("--emote-renderer=".length);
    } else if (arg === "--no-emote") {
      value = "none";
    }

    if (value === null) {
      claudeArgs.push(arg);
      continue;
    }
    const parsed = parseRendererMode(value, "--emote-renderer");
    if (flagMode !== null && flagMode !== parsed) {
      throw new Error("conflicting claude-emote renderer flags");
    }
    flagMode = parsed;
    renderer = parsed;
  }

  return { renderer, claudeArgs };
}

function parseRendererMode(
  value: string,
  source: string,
): EmoteRendererMode {
  if (value === "desktop" || value === "terminal" || value === "none") {
    return value;
  }
  throw new Error(`${source} must be desktop, terminal, or none`);
}

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
 * Split raw `where.exe` stdout into an ordered, deduplicated list of
 * absolute paths. Pure.
 *
 * Rules:
 *   - Split on CR (`\r`) or LF (`\n`).
 *   - Trim each line; drop blank entries.
 *   - Preserve first-occurrence order; drop later duplicates.
 *
 * Empty / non-string input returns an empty array.
 */
export function parseWhereExecutableOutput(stdout: unknown): string[] {
  if (typeof stdout !== "string" || stdout === "") return [];
  const lines = stdout.split(/\r?\n/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Check whether the canonical WindowsApps `wt.exe` alias entry is
 * launchable, even when its AppX-managed target is unreachable.
 *
 * The AppX app-execution alias at
 * `%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe` is a symlink whose
 * target sits behind an AppX-managed ACL: `existsSync()` (and
 * `statSync()`) returns EACCES on that entry, but Windows itself
 * launches the alias just fine. `lstatSync()` does not follow the
 * symlink and reliably reports a symlink stat.
 *
 * Acceptance rule: the path is considered launchable if either
 *   - `existsSync()` returns true (regular file case), OR
 *   - `lstatSync()` reports a symlink (the AppX alias case).
 *
 * The symlink heuristic is intentionally NOT used for arbitrary
 * paths. `findWindowsTerminalExecutable()` only calls this helper
 * for the canonical WindowsApps path; PATH-scan candidates and
 * override candidates still require `existsSync()` to pass.
 */
export function probeWindowsAppsAlias(
  path: string,
  fsImpl: { existsSync: (p: string) => boolean; lstatSync: (p: string) => { isSymbolicLink(): boolean } | null },
): boolean {
  if (!path) return false;
  try {
    if (fsImpl.existsSync(path)) return true;
  } catch {
    // ignore — fall through to lstat
  }
  try {
    const s = fsImpl.lstatSync(path);
    if (s && typeof s.isSymbolicLink === "function" && s.isSymbolicLink()) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * Minimal filesystem surface the resolver needs.
 */
export interface FsProbe {
  existsSync(p: string): boolean;
  lstatSync(p: string): { isSymbolicLink(): boolean } | null;
}

/**
 * Minimal child-process surface for `where.exe`.
 */
export interface ExecProbe {
  execFileSync(file: string, args: string[], opts: WhereExecOptions): string;
}

export interface WhereExecOptions {
  encoding: "utf8";
  stdio: ["ignore", "pipe", "ignore"];
  shell: false;
  windowsHide: true;
  timeout: number;
}

const defaultFs: FsProbe = {
  existsSync: (p) => {
    try {
      return nodeExistsSync(p);
    } catch {
      return false;
    }
  },
  lstatSync: (p) => {
    try {
      return nodeLstatSync(p);
    } catch {
      return null;
    }
  },
};

const defaultExec: ExecProbe = {
  execFileSync(file, args, opts) {
    return nodeExecFileSync(file, args, opts) as string;
  },
};

/**
 * Locate the Windows Terminal executable (`wt.exe`).
 *
 * Resolution order:
 *   1. Nonblank `CLAUDE_EMOTE_WT_EXE` test/diagnostic override.
 *      Existence requires strict `existsSync()` — overrides are
 *      user-controlled, so an override that doesn't exist is skipped.
 *   2. `%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe` (the canonical
 *      Microsoft Store alias). Acceptance uses
 *      `probeWindowsAppsAlias()` so the AppX alias case
 *      (lstat-confirmed symlink, existsSync-EACCES) still matches.
 *   3. `where.exe wt.exe` output, in order, deduped against (1) and (2).
 *      The invocation uses direct argv, `shell:false`, `windowsHide:true`,
 *      a 2-second timeout, and silent stderr; never `cmd /c`, never
 *      `start`, never PowerShell.
 *   4. `wt.exe` / `wt` on PATH, via a `existsSync()`-only scan.
 *
 * On non-Windows platforms the resolver returns null without touching
 * the filesystem or the environment.
 *
 * Returns null when nothing in the candidate list is launchable, so
 * the caller can fall back to the attached-child mode.
 *
 * Debug logging is only emitted when `CLAUDE_EMOTE_DEBUG=1` is set.
 */
export function findWindowsTerminalExecutable(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  fsImpl: FsProbe = defaultFs,
  execImpl: ExecProbe = defaultExec,
): string | null {
  if (platform !== "win32") return null;

  const debug = env.CLAUDE_EMOTE_DEBUG === "1";
  const dbg = (msg: string): void => {
    if (debug) process.stderr.write(`[claude-emote] ${msg}\n`);
  };

  const seen = new Set<string>();
  const consider = (path: string, isLaunchable: boolean): string | null => {
    if (!path) return null;
    const norm = path.replace(/\\/g, "/");
    if (seen.has(norm)) return null;
    seen.add(norm);
    if (!isLaunchable) {
      dbg(`wt resolver: candidate ${path} is not launchable`);
      return null;
    }
    dbg(`wt resolver: using candidate ${path}`);
    return path;
  };

  // 1) Override.
  const overrideRaw = env.CLAUDE_EMOTE_WT_EXE;
  const override =
    typeof overrideRaw === "string" ? overrideRaw.trim() : "";
  if (override) {
    let exists = false;
    try {
      exists = fsImpl.existsSync(override);
    } catch {
      exists = false;
    }
    if (exists) return consider(override, true);
    dbg(`wt resolver: override ${override} does not exist`);
  }

  // 2) Canonical WindowsApps alias.
  const local = env.LOCALAPPDATA;
  if (typeof local === "string" && local) {
    const alias = join(local, "Microsoft", "WindowsApps", "wt.exe");
    if (consider(alias, probeWindowsAppsAlias(alias, fsImpl))) return alias;
  }

  // 3) where.exe wt.exe.
  try {
    const stdout = execImpl.execFileSync("where.exe", ["wt.exe"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
      windowsHide: true,
      timeout: 2_000,
    });
    for (const p of parseWhereExecutableOutput(stdout)) {
      const hit = consider(p, fsImpl.existsSync(p));
      if (hit) return hit;
    }
  } catch {
    // where.exe missing or timed out — fall through to PATH scan.
  }

  // 4) PATH scan.
  if (typeof env.PATH === "string" && env.PATH) {
    const onPath = findExecutableOnPath("wt", platform, env.PATH, fsImpl);
    if (onPath) return onPath;
  }

  return null;
}

/**
 * Pure decision: where the avatar pane should be launched.
 *
 * The Windows Terminal pane branch is ONLY available when ALL of:
 *   - platform === "win32"
 *   - process.env.WT_SESSION is a non-empty (non-whitespace) string.
 *     This proves the launcher itself is running inside Windows
 *     Terminal. Spawning wt.exe from CMD / PowerShell / VS Code
 *     / etc. would otherwise target an unrelated window.
 *   - the wt executable resolves to an existing file (see
 *     findWindowsTerminalExecutable).
 *
 * In every other case the launcher falls back to attaching the
 * avatar as a normal child of itself.
 *
 * Pure: no filesystem side effects, no `process.platform` global
 * reads, no environment mutation. Pass `env` and `platform`
 * explicitly so the same call is exercised by unit tests.
 *
 * "test-mode" is intentionally NOT a parameter here. The launcher
 * short-circuits to test mode before calling this helper.
 */
export interface AvatarLaunchDecision {
  kind: "windows-terminal" | "attached";
  reason:
    | "inside-windows-terminal"
    | "not-windows"
    | "not-inside-windows-terminal"
    | "wt-not-found";
}

export function decideAvatarLaunchMode(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  wtExecutable: string | null,
): AvatarLaunchDecision {
  if (platform !== "win32") {
    return { kind: "attached", reason: "not-windows" };
  }
  const sessionRaw = env.WT_SESSION;
  const sessionIsSet =
    typeof sessionRaw === "string" && sessionRaw.trim() !== "";
  if (!sessionIsSet) {
    return { kind: "attached", reason: "not-inside-windows-terminal" };
  }
  if (wtExecutable === null) {
    return { kind: "attached", reason: "wt-not-found" };
  }
  return { kind: "windows-terminal", reason: "inside-windows-terminal" };
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
