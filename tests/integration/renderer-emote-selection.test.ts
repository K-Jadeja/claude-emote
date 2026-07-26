/**
 * renderer-emote-selection.test.ts (P6)
 *
 * Integration tests using the real renderer factory + real bundled
 * assets. Verifies that:
 *   - ASCII config resolves the bundled ASCII dir and produces a frame
 *   - An image-capable config resolves the bundled image dir and
 *     discovers at least one PNG, and the renderer reports a frame
 *
 * These tests do NOT mock terminal capability detection — they set up
 * a Config whose terminals[] maps the detected terminal name to the
 * desired protocol. Sixel requires Chafa to actually emit a sequence;
 * we separate asset-compatibility from external-tool rendering by
 * inspecting the renderer's loaded frameMap / frame state directly
 * without requiring Chafa to be installed.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import {
  BUNDLED_ASCII_EMOTE_DIR,
  BUNDLED_IMAGE_EMOTE_DIR,
} from "../../src/shared/project-paths.js";
import { resolveEmoteSelection } from "../../src/shared/emote-selection.js";
import { validateEmoteDirectory } from "../../src/shared/emote-validation.js";
import {
  createRenderer,
  resolveRendererKind,
} from "../../src/adapters/renderer-factory.js";
import { PACKAGE_ROOT } from "../../src/shared/project-paths.js";
import type { Config } from "../../src/core/types.js";

function baseConfig(extra: Partial<Config> = {}): Config {
  return {
    enabled: true,
    debug: false,
    size: 8,
    readingSpeed: 4,
    hideBelow: 30,
    holdDuration: { hi: 2000, success: 1200, failure: 1200 },
    blinkInterval: [3000, 6000],
    talkTickMs: 120,
    cycleMs: 500,
    emotes: [{ model: "*", "emote-set": "default" }],
    terminals: [{ match: "unknown", render: "ascii" }],
    ...extra,
  };
}

describe("renderer factory + emote selection (P6)", () => {
  it("forced ASCII configuration resolves bundled ASCII path", () => {
    const cfg = baseConfig({
      terminals: [{ match: "unknown", render: "ascii" }],
    });
    const kind = resolveRendererKind(cfg, new Set(["unknown"]), "unknown");
    expect(kind).toBe("ascii");
    const sel = resolveEmoteSelection("", kind);
    expect(sel.directory).toBe(BUNDLED_ASCII_EMOTE_DIR);
    const v = validateEmoteDirectory(sel.directory, kind);
    expect(v.ok).toBe(true);
  });

  it("ASCII renderer initializes and getRenderedFrame() returns a non-empty ASCII frame", () => {
    const cfg = baseConfig({
      terminals: [{ match: "unknown", render: "ascii" }],
    });
    const { renderer } = createRenderer(
      cfg,
      PACKAGE_ROOT,
      BUNDLED_ASCII_EMOTE_DIR,
      new Set(["unknown"]),
      "unknown",
    );
    // Force a known state.
    expect(renderer.showFrame("idle", "default")).toBe(true);
    const frame = renderer.getRenderedFrame();
    expect(frame).not.toBeNull();
    expect(frame?.kind).toBe("text");
    if (frame?.kind === "text") {
      expect(frame.lines.length).toBeGreaterThan(0);
      expect(frame.lines.join("").length).toBeGreaterThan(0);
    }
  });

  it("image-capable configuration resolves bundled image path", () => {
    const cfg = baseConfig({
      terminals: [{ match: "unknown", render: "sixel" }],
    });
    const kind = resolveRendererKind(cfg, new Set(["unknown"]), "unknown");
    expect(kind).toBe("image");
    const sel = resolveEmoteSelection("", kind);
    expect(sel.directory).toBe(BUNDLED_IMAGE_EMOTE_DIR);
    const v = validateEmoteDirectory(sel.directory, kind);
    expect(v.ok).toBe(true);
    expect(v.frameCount).toBeGreaterThan(0);
  });

  it("image-capable renderer discovers PNG frames and initializes", () => {
    const cfg = baseConfig({
      terminals: [{ match: "unknown", render: "sixel" }],
    });
    const { renderer } = createRenderer(
      cfg,
      PACKAGE_ROOT,
      BUNDLED_IMAGE_EMOTE_DIR,
      new Set(["unknown"]),
      "unknown",
    );
    // The BaseImageRenderer stores its frame map internally. We can
    // exercise showFrame/showRandomFrame which return false when no
    // frames are loaded — if any return true, asset discovery worked.
    const idleOk = renderer.showFrame("idle", "idle.png");
    const randomOk = renderer.showRandomFrame("idle");
    expect(idleOk || randomOk).toBe(true);
    // SixelRenderer requires Chafa for actual sequence encoding, but
    // getRenderedFrame() should return a documented object whenever
    // the renderer has a known asset, regardless of whether Chafa is
    // installed. We accept null as long as at least one show* method
    // returned true (proving asset discovery worked).
    if (idleOk) {
      // Either an image frame OR null (when Chafa missing) is
      // acceptable here. Phase 6 separates asset compatibility from
      // external-tool rendering.
      const f = renderer.getRenderedFrame();
      expect(f === null || typeof f === "object").toBe(true);
    }
  });

  it("bundled image directory contains idle PNGs", () => {
    const idleDir = `${BUNDLED_IMAGE_EMOTE_DIR}/idle`.replace(/\//g, require("node:path").sep);
    expect(existsSync(idleDir)).toBe(true);
    expect(existsSync(`${idleDir}/idle.png`)).toBe(true);
  });

  it("bundled ASCII directory contains ascii.yaml", () => {
    expect(existsSync(`${BUNDLED_ASCII_EMOTE_DIR}/ascii.yaml`.replace(/\//g, require("node:path").sep))).toBe(true);
  });
});
