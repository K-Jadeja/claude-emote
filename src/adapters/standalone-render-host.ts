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
 * Live-frame contract (P5):
 *   When a renderer is attached via attachFrameSource(), the host MUST
 *   pull the newest frame from that getter at every actual redraw. It
 *   must not snapshot the frame once at attach time, because the
 *   renderer changes its `currentFrame` between requestRender() and the
 *   debounced redraw.
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
  clearPane,
} from "./terminal-output.js";

const REDRAW_DEBOUNCE_MS = 8;

export interface StandaloneRenderHostOptions {
  /** Pre-set the line height to overwrite when a text frame is rendered. */
  textRowsHint?: number;
  /** If true, suppress all writes (used for headless testing). */
  silent?: boolean;
}

export class StandaloneRenderHost {
  /**
   * Persistent frame getter. When non-null, the host pulls the renderer
   * frame at every actual redraw. When null, the host falls back to
   * `currentFrame` for backward compatibility with demos / unit tests.
   */
  private frameSource: (() => RenderedFrame | null) | null = null;
  private currentFrame: RenderedFrame | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduled = false;
  private lastTextRows = 0;
  private started = false;
  private stopped = false;
  /**
   * Phase 10.1 visual-pane surface initialization flag. When set,
   * the next redrawNow() first emits a clear-pane + cursor-home
   * sequence so any pre-existing text (the wrap-prone diagnostic
   * rows from the avatar-process startup) is erased before the
   * renderer takes ownership of the pane. The flag is then cleared
   * so subsequent redraws use the normal erase-N-lines path.
   */
  private surfaceClearPending = false;
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
    if (this.stopped) return;
    if (this.scheduled) return;
    this.scheduled = true;
    if (this.pendingTimer) return;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      // A shutdown between schedule and fire must not draw.
      if (this.stopped) {
        this.scheduled = false;
        return;
      }
      this.scheduled = false;
      this.redrawNow();
    }, REDRAW_DEBOUNCE_MS);
  }

  /**
   * Resolve the current frame from the live source if attached, otherwise
   * fall back to the manually-set cached frame. Called only inside
   * redrawNow() so the value is sampled at redraw time, not at schedule
   * time.
   */
  private resolveFrame(): RenderedFrame | null {
    if (this.frameSource !== null) {
      return this.frameSource();
    }
    return this.currentFrame;
  }

  /** Force a synchronous redraw without debouncing. */
  redrawNow(): void {
    if (this.stopped) return;
    const frame = this.resolveFrame();
    if (!frame) return;
    // Re-check stopped after pulling frame — the getter might have caused
    // shutdown as a side effect.
    if (this.stopped) return;
    if (this.silent) {
      this.sink?.(frame);
      return;
    }

    if (this.surfaceClearPending) {
      // Visual-pane initialization. Emitted before the cursor-home
      // so the pane is fully cleared first; this guarantees the
      // wrap-prone diagnostic rows from startup are erased before
      // the renderer takes ownership.
      clearPane();
      this.surfaceClearPending = false;
      this.lastTextRows = 0;
    }
    cursorHome();
    if (frame.kind === "text") {
      eraseLines(this.lastTextRows);
      for (const line of frame.lines) {
        writeRaw(line + "\r\n");
      }
      this.lastTextRows = frame.lines.length;
    } else if (frame.kind === "image") {
      // For images we don't track textual rows; the renderer manages its
      // own layout through cursor save/restore. Just emit the payload.
      writeRaw(frame.sequence);
    } else if (frame.kind === "placeholder") {
      eraseLines(this.lastTextRows);
      for (const line of frame.lines) {
        writeRaw(line + "\r\n");
      }
      this.lastTextRows = frame.lines.length;
    }
  }

  /**
   * Bind the renderer's current-frame getter. Subsequent requestRender()
   * calls (which originate inside the renderer's `show*` methods) pull
   * `getFrame()` at redraw time. The getter is retained, NOT snapshotted.
   * Attaching happens once in production; callers must not reattach for
   * every state.
   */
  attachFrameSource(getFrame: () => RenderedFrame | null): void {
    this.frameSource = getFrame;
    this.start();
    this.requestRender();
  }

  /**
   * Update the cached frame and trigger a debounced redraw. Used by demos
   * and isolated unit tests that do not attach a live renderer. Production
   * uses attachFrameSource() instead.
   */
  setCurrentFrame(frame: RenderedFrame | null): void {
    this.currentFrame = frame;
    this.requestRender();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.silent) hideCursor();
  }

  /**
   * Phase 10.1: schedule a one-time clear-pane + cursor-home that
   * fires before the next redrawNow(). Idempotent. The clearing
   * happens at the renderer boundary (not in the policy) so the
   * contract stays narrow and the rest of the renderer pipeline is
   * unchanged. Calling this on a stopped or silent host is a no-op.
   */
  initializeVisualSurface(): void {
    if (this.stopped) return;
    if (this.silent) return;
    if (this.surfaceClearPending) return;
    this.surfaceClearPending = true;
  }

  /** Restore the terminal to a sane state. Idempotent. */
  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.scheduled = false;
    this.frameSource = null;
    this.currentFrame = null;
    if (!this.silent) {
      cursorHome();
      writeRaw("\r\n");
      showCursor();
    }
  }

  /** Test hook: returns the frame the host WOULD draw right now. */
  peekFrame(): RenderedFrame | null {
    return this.frameSource !== null ? this.frameSource() : this.currentFrame;
  }
}