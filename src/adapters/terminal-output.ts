/**
 * terminal-output.ts
 *
 * Low-level cursor and pane control primitives used by the standalone
 * avatar process. Every escape sequence is grouped here so the rest of the
 * code never hardcodes VT100 sequences inline.
 *
 * All write paths go through `writeRaw()` so we have a single point that
 * can be redirected to a captured buffer during tests.
 */

import { WriteStream } from "node:tty";

let activeStream: WriteStream | ((buf: string) => void) = process.stdout;

export function setOutputStream(s: WriteStream | ((buf: string) => void)): void {
  activeStream = s;
}

export function writeRaw(buf: string): void {
  if (typeof activeStream === "function") {
    activeStream(buf);
  } else {
    activeStream.write(buf);
  }
}

// --- Cursor -----------------------------------------------------------------

/** Hide the cursor (DEC). */
export function hideCursor(): void {
  writeRaw("\x1b[?25l");
}

/** Show the cursor (DEC). */
export function showCursor(): void {
  writeRaw("\x1b[?25h");
}

/** Save the cursor (DECSC, also supported by Windows Terminal). */
export function saveCursor(): void {
  writeRaw("\x1b7");
}

/** Restore the cursor (DECRC). */
export function restoreCursor(): void {
  writeRaw("\x1b8");
}

/** Move cursor to row/col 1. */
export function cursorHome(): void {
  writeRaw("\x1b[H");
}

/** Erase the entire pane and home the cursor. */
export function clearPane(): void {
  writeRaw("\x1b[2J\x1b[H");
}

/** Erase N lines starting from the cursor row. */
export function eraseLines(n: number): void {
  if (n <= 0) return;
  writeRaw(`\x1b[${n}M`);
}
