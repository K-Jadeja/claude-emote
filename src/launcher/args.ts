/**
 * args.ts
 *
 * Pure argument-construction helpers used by the claude-emote launcher.
 * Kept separate from claude-emote.ts so they can be imported in unit tests
 * without triggering the full launcher orchestration.
 */

import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
  const out: string[] = [
    AVATAR_PROCESS,
    `--port=${opts.port}`,
    `--instance=${opts.instanceId}`,
  ];
  if (opts.emoteDir !== null && opts.emoteDir !== undefined) {
    out.push(`--emoteDir=${opts.emoteDir}`);
  }
  out.push(`--parentPid=${opts.parentPid}`);
  return out;
}

export interface WindowsTerminalPaneOptions {
  paneArgs: string[];
  size?: number;
  title?: string;
  workingDir?: string;
}

/**
 * Build the Windows Terminal split-pane argument list. Pure.
 *
 * Per spec: never use `-F` (that means fullscreen, not force).
 * Target the current window explicitly with `-w 0`.
 */
export function buildWindowsTerminalArgs(
  opts: WindowsTerminalPaneOptions,
): string[] {
  const inner = buildCmdLine(opts.paneArgs);
  const size = opts.size ?? 0.25;
  const title = opts.title ?? "claude-emote";
  const cwd = opts.workingDir ?? PROJECT_ROOT;
  const args: string[] = [
    "-w", "0",
    "split-pane",
    "-V",
    "--size", String(size),
    "-d", cwd,
    "--title", title,
    "cmd", "/c", inner,
  ];
  if (args.includes("-F")) {
    throw new Error("buildWindowsTerminalArgs must never emit -F (fullscreen).");
  }
  return args;
}

export function buildCmdLine(parts: string[]): string {
  return parts
    .map((p) => (/[\s"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p))
    .join(" ");
}
