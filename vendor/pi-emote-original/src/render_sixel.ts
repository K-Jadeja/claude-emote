import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BaseImageRenderer } from "./render_image.js";
import type { ImageDims } from "./render_image.js";
import { log } from "./log.js";

/**
 * Windows Terminal Sixel renderer backed by Chafa.
 *
 * Chafa emits a few terminal-control wrappers around the Sixel payload
 * (hide/show cursor and a final IND/newline-style movement). The pi widget
 * already owns cursor/layout behavior, so those wrappers are stripped and only
 * the Sixel DCS payload is rendered inline.
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
      const downToLastImageRow = rows > 1 ? `\x1b[${rows - 1}B` : "";
      const rightPastImage = `\x1b[${this.size}C`;

      // Prefix with a dummy Kitty graphics sequence (\x1b_G;) so pi-tui's
      // isImageLine() recognizes it as an image line. This prevents the TUI
      // from running normalizeTerminalOutput() on it or crashing on width checks.
      // Since there's no 'i=' param, Kitty image cleanup safely ignores it.
      //
      // The DCS payload is wrapped in DECSC/DECRC (\x1b7 / \x1b8) to neutralize
      // Windows Terminal's Sixel cursor side-effects. After restore, we explicitly
      // move to the widget position expected after an advancing image.
      return `\x1b_G;\x1b7${sixel}\x1b8${downToLastImageRow}${rightPastImage}`;
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

function findChafaPath(): string | null {
  const configured = process.env.PI_EMOTE_CHAFA_PATH;
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
