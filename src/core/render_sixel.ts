import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BaseImageRenderer } from "./render_image.js";
import type { ImageDims } from "./render_image.js";
import { log } from "./log.js";

/**
 * Windows Terminal Sixel renderer backed by Chafa.
 *
 * V1 port note (claude-emote):
 *   - Chafa invocation and wrapper-stripping logic are preserved from upstream.
 *   - Removed: the dummy Kitty graphics prefix (\x1b_G;) that existed only to
 *     help pi-tui's isImageLine() recognise the line. Claude-emote renders in
 *     its own pane and does not run pi-tui's normaliser.
 *   - Removed: the Pi-widget cursor moves (\x1b[NB / \x1b[NC) because the
 *     standalone avatar pane handles cursor home/redraw through its own host
 *     (see src/adapters/standalone-render-host.ts). The host positions the
 *     cursor before redrawing each frame, so the Sixel sequence only needs to
 *     carry the image payload.
 *   - The DECSC/DECRC (\x1b7 / \x1b8) wrappers are kept around the Sixel
 *     payload to neutralise Windows Terminal's side-effects on cursor position
 *     and visibility. Cursor visibility is restored explicitly during cleanup.
 */
export class SixelRenderer extends BaseImageRenderer {
  protected cursorAdvances = true;
  private chafaPath: string | null;

  constructor(size: number) {
    super(size);
    this.chafaPath = findChafaPath();
    log(`SixelRenderer: chafa=${this.chafaPath ?? "not found"}`);
  }

  protected encode(base64: string, _dims: ImageDims, rows: number, _yOffset: number): string | null {
    if (!this.chafaPath) {
      log("SixelRenderer.encode: Chafa not found");
      return null;
    }

    try {
      const png = Buffer.from(base64, "base64");
      const out = execFileSync(this.chafaPath, [
        "--format=sixels",
        `--size=${this.size}x${rows}`,
        `--view-size=${this.size}x${rows}`,
        "--align=top,left",
        "--margin-bottom=0",
        "--margin-right=0",
        "--animate=off",
        "--probe=off",
        "--relative=on",
        "-",
      ], {
        input: png,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      });

      const sixel = stripChafaWrappers(out);
      // Wrap the Sixel payload in DECSC/DECRC to neutralise Windows Terminal's
      // cursor side-effects. After restore, the standalone render host will
      // move the cursor to its home position for the next redraw.
      return `\x1b7${sixel}\x1b8`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`SixelRenderer.encode: chafa failed: ${message}`);
      return null;
    }
  }

  dispose() {
    this.currentFrame = null;
  }
}

function stripChafaWrappers(sequence: string): string {
  return sequence
    .replace(/^\x1b\[\?25l/, "")
    .replace(/\x1bD\x1b\[\?25h$/, "")
    .replace(/\x1b\[\?25h$/, "")
    .replace(/\r?\n/g, "");
}

/**
 * Resolve the Chafa executable path.
 *
 * Lookup order:
 *   1. $CLAUDE_EMOTE_CHAFA_PATH (preferred for V1)
 *   2. $PI_EMOTE_CHAFA_PATH (backwards-compatibility fallback)
 *   3. chafa/Chafa.exe on PATH (via where.exe / which)
 *   4. Winget-installed Chafa under %LOCALAPPDATA%\Microsoft\WinGet\Packages
 */
function findChafaPath(): string | null {
  const configured =
    process.env.CLAUDE_EMOTE_CHAFA_PATH ?? process.env.PI_EMOTE_CHAFA_PATH;
  if (configured && existsSync(configured)) return configured;

  for (const command of process.platform === "win32" ? ["chafa", "Chafa.exe"] : ["chafa"]) {
    const resolved = findOnPath(command);
    if (resolved) return resolved;
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const wingetPackages = join(localAppData, "Microsoft", "WinGet", "Packages");
      const wingetChafa = findFileRecursive(wingetPackages, "Chafa.exe", 4);
      if (wingetChafa) return wingetChafa;
    }
  }

  return null;
}

function findOnPath(command: string): string | null {
  try {
    const finder = process.platform === "win32" ? "where.exe" : "which";
    const out = execFileSync(finder, [command], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 2000,
    });
    const first = out.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return first && existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

function findFileRecursive(dir: string, fileName: string, depth: number): string | null {
  if (depth < 0 || !existsSync(dir)) return null;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
      return fullPath;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findFileRecursive(join(dir, entry.name), fileName, depth - 1);
    if (found) return found;
  }

  return null;
}
