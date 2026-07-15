import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StandaloneRenderHost } from "../../src/adapters/standalone-render-host.js";
import { setOutputStream, writeRaw } from "../../src/adapters/terminal-output.js";
import type { RenderedFrame } from "../../src/core/renderer.js";

describe("StandaloneRenderHost (M2)", () => {
  let captured: string;
  let host: StandaloneRenderHost;
  let frameSink: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    captured = "";
    setOutputStream((buf: string) => {
      captured += buf;
    });
    frameSink = vi.fn();
    host = new StandaloneRenderHost({ silent: true }, frameSink);
  });

  afterEach(() => {
    host.shutdown();
  });

  it("exposes a requestRender() method (the renderer contract)", () => {
    expect(typeof host.requestRender).toBe("function");
  });

  it("calls requestRender and feeds the cached frame to the sink after debounce", async () => {
    const frame: RenderedFrame = { kind: "text", lines: ["a", "b"] };
    host.setCurrentFrame(frame);
    expect(frameSink).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 20));
    expect(frameSink).toHaveBeenCalledTimes(1);
    expect(frameSink).toHaveBeenCalledWith(frame);
  });

  it("coalesces multiple requestRender calls into a single redraw", async () => {
    host.setCurrentFrame({ kind: "text", lines: ["a"] });
    host.requestRender();
    host.requestRender();
    host.requestRender();
    await new Promise((r) => setTimeout(r, 20));
    expect(frameSink).toHaveBeenCalledTimes(1);
  });

  it("does not write terminal bytes when silent (test mode)", async () => {
    host.setCurrentFrame({ kind: "text", lines: ["x"] });
    await new Promise((r) => setTimeout(r, 20));
    expect(captured).toBe("");
  });

  it("writes cursor home + erase-lines + lines for text frames when not silent", async () => {
    // Recreate in non-silent mode
    captured = "";
    setOutputStream((buf: string) => {
      captured += buf;
    });
    const live = new StandaloneRenderHost();
    live.setCurrentFrame({ kind: "text", lines: ["hello", "world"] });
    await new Promise((r) => setTimeout(r, 20));
    expect(captured).toContain("\x1b[H"); // cursor home
    expect(captured).toContain("hello");
    expect(captured).toContain("world");
    live.shutdown();
    // shutdown restores the cursor
    expect(captured).toContain("\x1b[?25h");
  });

  it("erases prior text frame lines before drawing the new one (no ghosting)", async () => {
    captured = "";
    setOutputStream((buf: string) => {
      captured += buf;
    });
    const live = new StandaloneRenderHost();
    live.setCurrentFrame({ kind: "text", lines: ["aaa", "bbb", "ccc"] });
    await new Promise((r) => setTimeout(r, 20));
    const before = captured;
    live.setCurrentFrame({ kind: "text", lines: ["x"] });
    await new Promise((r) => setTimeout(r, 20));
    // The second draw must contain an eraseLines(3) command before the new content.
    const secondSlice = captured.slice(before.length);
    expect(secondSlice).toContain("\x1b[3M");
    expect(secondSlice).toContain("x");
    live.shutdown();
  });

  it("passes image sequences through unchanged", async () => {
    captured = "";
    setOutputStream((buf: string) => {
      captured += buf;
    });
    const live = new StandaloneRenderHost();
    const imageSeq = "\x1b7\x1bPq#0;2;100;100;100\x1b\\\x1b8";
    live.setCurrentFrame({
      kind: "image",
      sequence: imageSeq,
      rows: 8,
      cursorAdvances: true,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(captured).toContain(imageSeq);
    live.shutdown();
  });
});
