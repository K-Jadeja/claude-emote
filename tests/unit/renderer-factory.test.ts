import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { createRenderer } from "../../src/adapters/renderer-factory.js";
import { AsciiRenderer } from "../../src/core/render_ascii.js";
import { SixelRenderer } from "../../src/core/render_sixel.js";
import type { Config } from "../../src/core/types.js";

const EXT_DIR = resolve(process.cwd());
const ASCII_EMOTES = resolve(EXT_DIR, "emotes", "ascii");

const ASCII_CONFIG: Config = {
  enabled: true,
  debug: false,
  size: 8,
  readingSpeed: 4,
  hideBelow: 20,
  holdDuration: { hi: 2000, success: 1200, failure: 1200 },
  blinkInterval: [3000, 6000],
  talkTickMs: 120,
  cycleMs: 500,
  emotes: [{ model: "*", "emote-set": "default" }],
  terminals: [{ match: "unknown", render: "ascii" }],
};

describe("RendererFactory (M2)", () => {
  it("constructs an AsciiRenderer when configured", () => {
    const { renderer, resolved } = createRenderer(
      ASCII_CONFIG,
      EXT_DIR,
      ASCII_EMOTES,
      new Set(["unknown"]),
    );
    expect(resolved.protocol).toBe("ascii");
    expect(renderer).toBeInstanceOf(AsciiRenderer);
  });

  it("constructs a SixelRenderer when configured", () => {
    const cfg: Config = {
      ...ASCII_CONFIG,
      terminals: [{ match: "windows-terminal", render: "sixel" }],
    };
    const { renderer, resolved } = createRenderer(
      cfg,
      EXT_DIR,
      ASCII_EMOTES,
      new Set(["windows-terminal"]),
    );
    expect(resolved.protocol).toBe("sixel");
    expect(renderer).toBeInstanceOf(SixelRenderer);
  });

  it("setTuiHost wires a requestRender contract to the renderer", () => {
    const { renderer, setTuiHost } = createRenderer(
      ASCII_CONFIG,
      EXT_DIR,
      ASCII_EMOTES,
      new Set(["unknown"]),
    );
    const host = { requestRender: () => {} };
    expect(() => setTuiHost(host)).not.toThrow();
    // Calling showFrame should now be safe and not throw.
    expect(renderer.showFrame("idle", "default")).toBe(true);
  });
});
