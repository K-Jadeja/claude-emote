import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * V1 port note (claude-emote):
 *   The original pi-emote resolved its user-extension directory through
 *   `@earendil-works/pi-coding-agent`'s `getAgentDir()`, which is Pi-specific.
 *   Claude-emote has no such runtime dependency, so this module exposes
 *   analogous helpers rooted at `$CLAUDE_EMOTE_DATA_DIR` (if set) or
 *   `~/.claude-emote` on disk.
 *
 *   The shape of the helpers is kept stable so the rest of the copied core
 *   (config.ts, render_ascii.ts, etc.) can call them without change.
 */

const DEFAULT_DATA_DIR = join(homedir(), ".claude-emote");
const EXTENSION_DIR_NAME = "extensions";
const EXTENSION_NAME = "claude-emote";
const PROJECT_CONFIG_DIR_NAME = ".claude-emote";

export function getEmoteAgentDir(): string {
  return process.env.CLAUDE_EMOTE_DATA_DIR?.trim() || DEFAULT_DATA_DIR;
}

export function getUserExtensionDir(): string {
  return join(getEmoteAgentDir(), EXTENSION_DIR_NAME, EXTENSION_NAME);
}

export function getProjectConfigDirName(): string {
  return PROJECT_CONFIG_DIR_NAME;
}

export function getProjectExtensionDir(cwd: string): string {
  return join(cwd, getProjectConfigDirName(), EXTENSION_DIR_NAME, EXTENSION_NAME);
}
