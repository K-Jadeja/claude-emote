/**
 * standalone-render-host.ts
 *
 * Adapts the avatar pane to the `Renderer` interface's `setTui(tui)` contract.
 *
 * Upstream renderers call `tui?.requestRender()` whenever the current frame
 * changes. In the original pi-emote codebase, `tui` was the live TUI object
 * whose diff engine would pick up the new frame and route it to the right
 * row. Claude-emote renders inside a dedicated Windows Terminal pane that
 * has no shared TUI, so this module is the smallest possible stand-in that
 * satisfies the contract:
 *
 *   - It exposes `requestRender()` (called by renderers).
 *   - It writes the *current* RenderedFrame at the pane's home position.
 *   - It debounces redundant renders (some upstream renderers call
 *     requestRender() more than once per logical change).
 *   - It hides the cursor while active and restores it on shutdown.
 *
 * Layout strategy for ASCII text frames:
 *   1. Cursor home (pane row 1, col 1).
 *   2. Erase each old frame line (so old text is overwritten).
 *   3. Write each new line with explicit \r\n terminators so the pane does
 *      NOT scroll — the writer stays within the fixed line count.
 *
 * Layout strategy for image frames:
 *   The renderer's escape sequence already carries DECSC/DECRC and the
 *   image payload. We just home the cursor before writing the sequence so
 *   the avatar lands at the pane's top-left.
 */

import type { RenderedFrame } from "../core/renderer.js";
import {
  writeRaw,
  hideCursor,
  showCursor,
  cursorHome,
  eraseLines,
} from "./terminal-output.js";

const REDRAW_DEBOUNCE_MS = 8;

export interface StandaloneRenderHostOptions {
  /** Pre-set the line height to overwrite when a text frame is rendered. */
  textRowsHint?: number;
  /** If true, suppress all writes (used for headless testing). */
  silent?: boolean;
}

export class StandaloneRenderHost {
  private currentFrame: RenderedFrame | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduled = false;
  private lastTextRows = 0;
  private started = false;
  private readonly silent: boolean;
  private readonly sink?: (frame: RenderedFrame) => void;

  constructor(opts: StandaloneRenderHostOptions = {}, sink?: (frame: RenderedFrame) => void) {
    this.silent = !!opts.silent;
    this.sink = sink;
  }

  /**
   * Implements the `tui.requestRender()` contract expected by every
   * upstream renderer. Coalesces multiple calls into a single redraw on the
   * next macrotask.
   */
  requestRender(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    if (this.pendingTimer) return;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.scheduled = false;
      this.redrawNow();
    }, REDRAW_DEBOUNCE_MS);
  }

  /** Force a synchronous redraw without debouncing. */
  redrawNow(): void {
    if (!this.currentFrame) return;
    if (this.silent) {
      this.sink?.(this.currentFrame);
      return;
    }

    cursorHome();
    if (this.currentFrame.kind === "text") {
      eraseLines(this.lastTextRows);
      for (const line of this.currentFrame.lines) {
        writeRaw(line + "\r\n");
      }
      this.lastTextRows = this.currentFrame.lines.length;
    } else if (this.currentFrame.kind === "image") {
      // For images we don't track textual rows; the renderer manages its
      // own layout through cursor save/restore. Just emit the payload.
      writeRaw(this.currentFrame.sequence);
    } else if (this.currentFrame.kind === "placeholder") {
      eraseLines(this.lastTextRows);
      for (const line of this.currentFrame.lines) {
        writeRaw(line + "\r\n");
      }
      this.lastTextRows = this.currentFrame.lines.length;
    }
  }

  /** Bind the renderer so subsequent frames route through this host. */
  attachFrameSource(getFrame: () => RenderedFrame | null): void {
    this.start();
    // Pull the current frame so debounced renders have something to draw.
    this.currentFrame = getFrame();
    // Also schedule an immediate draw so the pane is populated right away.
    this.requestRender();
  }

  /** Update the cached frame and trigger a debounced redraw. */
  setCurrentFrame(frame: RenderedFrame | null): void {
    this.currentFrame = frame;
    this.requestRender();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.silent) hideCursor();
  }

  /** Restore the terminal to a sane state. Idempotent. */
  shutdown(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.scheduled = false;
    if (!this.silent) {
      cursorHome();
      writeRaw("\r\n");
      showCursor();
    }
  }

  /** Test hook: returns the cached frame without redrawing. */
  peekFrame(): RenderedFrame | null {
    return this.currentFrame;
  }
}
