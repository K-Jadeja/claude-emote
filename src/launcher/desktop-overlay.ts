import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import type { SpawnOptions } from "node:child_process";
import { PROJECT_ROOT } from "./args.js";
import { SESSION_CAPABILITY_ENV } from "../shared/session-capability.js";
import {
  HIDE_SESSION_LABEL_ENV,
  SESSION_LABEL_ENV,
} from "../shared/session-label.js";

export interface DesktopOverlayCommand {
  executable: string;
  args: string[];
  cwd: string;
  kind: "override" | "packaged" | "development";
}

export interface DesktopOverlaySpawnSpec extends DesktopOverlayCommand {
  options: SpawnOptions;
}

/**
 * Resolve the native shell without putting session data on its command line.
 * Windows x64 is the first supported production target.
 */
export function resolveDesktopOverlay(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  arch: string,
  root = PROJECT_ROOT,
  fileExists: (path: string) => boolean = existsSync,
): DesktopOverlayCommand {
  const override = env.CLAUDE_EMOTE_OVERLAY_EXE?.trim();
  if (override) {
    const path = resolve(override);
    if (!fileExists(path)) {
      throw new Error(`CLAUDE_EMOTE_OVERLAY_EXE does not exist: ${path}`);
    }
    return commandForExecutable(path, "override");
  }

  if (platform !== "win32" || arch !== "x64") {
    throw new Error(
      `desktop overlay is not packaged for ${platform}/${arch}; use --emote-renderer=terminal`,
    );
  }

  const packaged = join(
    root,
    "desktop",
    "dist",
    "claude-pet",
    "claude-pet-win_x64.exe",
  );
  const resources = join(dirname(packaged), "resources.neu");
  if (fileExists(packaged) && fileExists(resources)) {
    return {
      executable: packaged,
      args: [],
      cwd: dirname(packaged),
      kind: "packaged",
    };
  }

  const runtime = join(root, "desktop", "bin", "neutralino-win_x64.exe");
  const desktopRoot = join(root, "desktop");
  const entry = join(desktopRoot, "resources", "index.html");
  if (fileExists(runtime) && fileExists(entry)) {
    return {
      executable: runtime,
      args: ["--res-mode=directory", `--path=${desktopRoot}`],
      cwd: desktopRoot,
      kind: "development",
    };
  }

  throw new Error(
    "desktop overlay runtime is missing; run npm run overlay:package",
  );
}

export function buildDesktopOverlaySpawnSpec(
  command: DesktopOverlayCommand,
  parentEnv: NodeJS.ProcessEnv,
  endpoint: string,
  capabilityToken: string,
  sessionLabel: string | null,
): DesktopOverlaySpawnSpec {
  const overlayEnv = { ...parentEnv };
  delete overlayEnv[SESSION_LABEL_ENV];
  delete overlayEnv[HIDE_SESSION_LABEL_ENV];
  overlayEnv.CLAUDE_EMOTE_ENDPOINT = endpoint;
  overlayEnv[SESSION_CAPABILITY_ENV] = capabilityToken;
  if (sessionLabel === null) {
    overlayEnv[HIDE_SESSION_LABEL_ENV] = "1";
  } else {
    overlayEnv[SESSION_LABEL_ENV] = sessionLabel;
  }

  return {
    ...command,
    options: {
      cwd: command.cwd,
      env: overlayEnv,
      detached: false,
      shell: false,
      stdio: "ignore",
      // Do not set STARTF_USESHOWWINDOW/SW_HIDE for a GUI executable.
      // Neutralino can otherwise create a healthy WebView and taskbar entry
      // while its actual native window remains invisible.
      windowsHide: false,
    },
  };
}

function commandForExecutable(
  path: string,
  kind: DesktopOverlayCommand["kind"],
): DesktopOverlayCommand {
  if ([".js", ".cjs", ".mjs"].includes(extname(path).toLowerCase())) {
    return {
      executable: process.execPath,
      args: [path],
      cwd: dirname(path),
      kind,
    };
  }
  return { executable: path, args: [], cwd: dirname(path), kind };
}
