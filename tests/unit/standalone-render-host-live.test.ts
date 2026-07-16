/**
 * standalone-render-host-live.test.ts (P5)
 *
 * Regression for the live-frame defect. Before the fix the host only
 * snapshotted `getFrame()` once inside attachFrameSource() and discarded
 * the getter, so subsequent renderer-driven requestRender() calls drew
 * the stale one-time frame. These tests do NOT call setCurrentFrame() —
 * they exercise the production path: renderer calls requestRender(), the
 * host pulls the latest frame at redraw time.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StandaloneRenderHost } from "../../src/adapters/standalone-render-host.js";
import type { RenderedFrame } from "../../src/core/renderer.js";

const A: RenderedFrame = { kind: "text", lines: ["FRAME-A"] };
const B: RenderedFrame = { kind: "text", lines: ["FRAME-B"] };

describe("StandaloneRenderHost live-frame delivery (P5)", () => {
  let sink: ReturnType<typeof vi.fn>;
  let host: StandaloneRenderHost;
  let source: { current: RenderedFrame | null };

  beforeEach(() => {
    sink = vi.fn();
    source = { current: null };
    host = new StandaloneRenderHost({ silent: true }, sink);
    // Note: silent=true so the host does not write terminal bytes.
    host.attachFrameSource(() => source.current);
  });

  afterEach(() => {
    host.shutdown();
  });

  it("regression: requestRender() emits the live frame, not a one-time snapshot", async () => {
    // The renderer just transitioned to state A. It calls host.requestRender().
    source.current = A;
    host.requestRender();
    await new Promise((r) => setTimeout(r, 20));
    expect(sink).toHaveBeenCalledWith(A);
  });

  it("second renderer frame reaches the sink without re-attaching the source", async () => {
    source.current = A;
    host.requestRender();
    await new Promise((r) => setTimeout(r, 20));
    expect(sink).toHaveBeenLastCalledWith(A);

    sink.mockClear();
    source.current = B;
    host.requestRender();
    await new Promise((r) => setTimeout(r, 20));
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenLastCalledWith(B);
  });

  it("a frame changed before the debounce fires emits the NEWEST frame", async () => {
    // Renderer transitions to A, schedules a render, then transitions to B
    // before the debounce fires. The redraw must draw B.
    source.current = A;
    host.requestRender();
    // Within the 8ms debounce window, switch the source to B.
    await new Promise((r) => setTimeout(r, 1));
    source.current = B;
    await new Promise((r) => setTimeout(r, 30));
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenLastCalledWith(B);
  });

  it("coalesces multiple requestRender calls into a single redraw with the newest frame", async () => {
    source.current = A;
    host.requestRender();
    host.requestRender();
    host.requestRender();
    await new Promise((r) => setTimeout(r, 1));
    source.current = B;
    await new Promise((r) => setTimeout(r, 30));
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenLastCalledWith(B);
  });

  it("a null source emits nothing", async () => {
    source.current = null;
    host.requestRender();
    await new Promise((r) => setTimeout(r, 20));
    expect(sink).not.toHaveBeenCalled();
  });

  it("peekFrame() reflects the live source, not a stale snapshot", () => {
    expect(host.peekFrame()).toBeNull();
    source.current = A;
    expect(host.peekFrame()).toBe(A);
    source.current = B;
    expect(host.peekFrame()).toBe(B);
  });

  it("source frame takes precedence over setCurrentFrame", async () => {
    host.setCurrentFrame({ kind: "text", lines: ["MANUAL"] });
    sink.mockClear();
    source.current = A;
    host.requestRender();
    await new Promise((r) => setTimeout(r, 20));
    expect(sink).toHaveBeenLastCalledWith(A);
  });

  it("setCurrentFrame() still works when no source is attached", async () => {
    const manualOnly = new StandaloneRenderHost({ silent: true }, sink);
    manualOnly.setCurrentFrame({ kind: "text", lines: ["MANUAL"] });
    await new Promise((r) => setTimeout(r, 20));
    expect(sink).toHaveBeenCalledWith({ kind: "text", lines: ["MANUAL"] });
    manualOnly.shutdown();
  });

  it("shutdown cancels a queued redraw", async () => {
    const localSink = vi.fn();
    const localSource = { current: null as RenderedFrame | null };
    const cancellable = new StandaloneRenderHost({ silent: true }, localSink);
    cancellable.attachFrameSource(() => localSource.current);
    localSource.current = A;
    cancellable.requestRender();
    cancellable.shutdown();
    await new Promise((r) => setTimeout(r, 30));
    expect(localSink).not.toHaveBeenCalled();
  });

  it("shutdown is idempotent", () => {
    expect(() => {
      host.shutdown();
      host.shutdown();
      host.shutdown();
    }).not.toThrow();
  });
});