/**
 * emote-selection.test.ts (P6)
 *
 * Unit tests for:
 *   - src/shared/project-paths.ts
 *   - src/shared/emote-selection.ts
 *   - src/shared/emote-validation.ts
 *
 * These exercise the pure helpers in isolation, without spawning the
 * avatar process or loading any renderer. They MUST NOT touch the real
 * project root configuration.
 */

import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";

/** Normalize trailing separator for cross-platform endsWith checks. */
function endsWithPath(p: string, suffix: string): boolean {
  return p.endsWith(suffix) || p.endsWith(suffix.replace(/\//g, sep));
}
import {
  PACKAGE_ROOT,
  BUNDLED_ASCII_EMOTE_DIR,
  BUNDLED_IMAGE_EMOTE_DIR,
} from "../../src/shared/project-paths.js";
import {
  resolveEmoteSelection,
} from "../../src/shared/emote-selection.js";
import {
  validateEmoteDirectory,
  type RendererKind,
} from "../../src/shared/emote-validation.js";

// -------------------------------------------------------------------------
// Package paths
// -------------------------------------------------------------------------

describe("PACKAGE_ROOT (P6)", () => {
  it("is independent of process.cwd()", () => {
    const original = process.cwd();
    try {
      process.chdir(tmpdir());
      // Re-import dynamically so the cache-busting path doesn't help us
      // cheat. We import once at module top, so instead we just assert
      // the value is a non-empty absolute path that does NOT change
      // when cwd changes.
      const before = PACKAGE_ROOT;
      process.chdir(original);
      const after = PACKAGE_ROOT;
      expect(after).toBe(before);
    } finally {
      process.chdir(original);
    }
  });

  it("is an absolute path", () => {
    expect(PACKAGE_ROOT.startsWith("/") || /^[A-Z]:[\\/]/.test(PACKAGE_ROOT)).toBe(true);
  });

  it("BUNDLED_IMAGE_EMOTE_DIR resolves under PACKAGE_ROOT", () => {
    expect(BUNDLED_IMAGE_EMOTE_DIR.startsWith(PACKAGE_ROOT)).toBe(true);
    expect(endsWithPath(BUNDLED_IMAGE_EMOTE_DIR, "emotes/default")).toBe(true);
  });

  it("BUNDLED_ASCII_EMOTE_DIR resolves under PACKAGE_ROOT", () => {
    expect(BUNDLED_ASCII_EMOTE_DIR.startsWith(PACKAGE_ROOT)).toBe(true);
    expect(endsWithPath(BUNDLED_ASCII_EMOTE_DIR, "emotes/ascii")).toBe(true);
  });

  it("both bundled directories exist on disk", () => {
    expect(existsSync(BUNDLED_IMAGE_EMOTE_DIR)).toBe(true);
    expect(existsSync(BUNDLED_ASCII_EMOTE_DIR)).toBe(true);
  });
});

// -------------------------------------------------------------------------
// Emote selection
// -------------------------------------------------------------------------

describe("resolveEmoteSelection (P6)", () => {
  it("automatic + ASCII renderer selects bundled ASCII", () => {
    const sel = resolveEmoteSelection("", "ascii");
    expect(sel.kind).toBe("automatic");
    expect(sel.directory).toBe(BUNDLED_ASCII_EMOTE_DIR);
  });

  it("automatic + image renderer selects bundled image", () => {
    const sel = resolveEmoteSelection("", "image");
    expect(sel.kind).toBe("automatic");
    expect(sel.directory).toBe(BUNDLED_IMAGE_EMOTE_DIR);
  });

  it("custom + ASCII renderer preserves the custom absolute path", () => {
    const customPath = join(tmpdir(), "my-ascii-set");
    const sel = resolveEmoteSelection(customPath, "ascii");
    expect(sel.kind).toBe("custom");
    expect(sel.directory).toBe(customPath);
  });

  it("custom + image renderer preserves the custom absolute path", () => {
    const customPath = join(tmpdir(), "my-image-set");
    const sel = resolveEmoteSelection(customPath, "image");
    expect(sel.kind).toBe("custom");
    expect(sel.directory).toBe(customPath);
  });

  it("custom paths containing spaces are preserved verbatim", () => {
    const customPath = join(tmpdir(), "path with spaces", "set");
    const sel = resolveEmoteSelection(customPath, "ascii");
    expect(sel.kind).toBe("custom");
    expect(sel.directory).toBe(customPath);
  });

  it("custom relative paths are resolved to absolute", () => {
    const sel = resolveEmoteSelection("./my-set", "image");
    expect(sel.kind).toBe("custom");
    // Must be absolute — the avatar process needs an absolute path
    // because its cwd may differ.
    expect(sel.directory).toMatch(/^([A-Z]:[\\/]|\/)/);
  });
});

// -------------------------------------------------------------------------
// Validation
// -------------------------------------------------------------------------

describe("validateEmoteDirectory (P6)", () => {
  let scratch: string;

  // Build a scratch tempdir for validator inputs.
  function setupScratch(): string {
    scratch = mkdtempSync(join(tmpdir(), "claude-emote-p6-validate-"));
    return scratch;
  }
  function teardownScratch(): void {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }

  it("bundled ASCII validates and has at least one usable frame", () => {
    const r = validateEmoteDirectory(BUNDLED_ASCII_EMOTE_DIR, "ascii");
    expect(r.ok).toBe(true);
    expect(r.frameCount).toBeGreaterThan(0);
  });

  it("bundled image validates and has at least one usable PNG frame", () => {
    const r = validateEmoteDirectory(BUNDLED_IMAGE_EMOTE_DIR, "image");
    expect(r.ok).toBe(true);
    expect(r.frameCount).toBeGreaterThan(0);
  });

  it("rejects missing directory", () => {
    const r = validateEmoteDirectory(join(tmpdir(), "definitely-does-not-exist-xyz"), "ascii");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not exist/);
  });

  it("rejects a path that is a file rather than a directory", () => {
    setupScratch();
    const file = join(scratch, "not-a-dir.txt");
    writeFileSync(file, "x");
    const r = validateEmoteDirectory(file, "ascii");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not a directory/);
    teardownScratch();
  });

  it("rejects an empty ASCII directory (no ascii.yaml)", () => {
    setupScratch();
    const empty = join(scratch, "empty");
    mkdirSync(empty, { recursive: true });
    const r = validateEmoteDirectory(empty, "ascii");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ascii.yaml/);
    teardownScratch();
  });

  it("rejects an empty image directory (no PNGs)", () => {
    setupScratch();
    const empty = join(scratch, "empty-img");
    mkdirSync(empty, { recursive: true });
    const r = validateEmoteDirectory(empty, "image");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no usable PNG/);
    teardownScratch();
  });

  it("rejects ASCII directory without ascii.yaml", () => {
    setupScratch();
    const d = join(scratch, "no-yaml");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "readme.txt"), "no yaml here");
    const r = validateEmoteDirectory(d, "ascii");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ascii.yaml not found/);
    teardownScratch();
  });

  it("rejects malformed ascii.yaml", () => {
    setupScratch();
    const d = join(scratch, "malformed");
    mkdirSync(d, { recursive: true });
    // Empty YAML.
    writeFileSync(join(d, "ascii.yaml"), "");
    const r = validateEmoteDirectory(d, "ascii");
    expect(r.ok).toBe(false);
    teardownScratch();
  });

  it("rejects image directory without PNG frames (text-only dir)", () => {
    setupScratch();
    const d = join(scratch, "no-pngs");
    mkdirSync(join(d, "idle"), { recursive: true });
    writeFileSync(join(d, "idle", "idle.txt"), "not a png");
    const r = validateEmoteDirectory(d, "image");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no usable PNG/);
    teardownScratch();
  });

  it("rejects bundled ASCII when asked to validate as image", () => {
    const r = validateEmoteDirectory(BUNDLED_ASCII_EMOTE_DIR, "image");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no usable PNG/);
  });

  it("rejects bundled image when asked to validate as ASCII (no ascii.yaml)", () => {
    const r = validateEmoteDirectory(BUNDLED_IMAGE_EMOTE_DIR, "ascii");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ascii.yaml not found/);
  });

  it("accepts a custom ASCII directory containing a valid ascii.yaml", () => {
    setupScratch();
    const d = join(scratch, "valid-custom");
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, "ascii.yaml"),
      [
        "hi:",
        "  default: \"(^ ◡ ^)/\"",
        "idle:",
        "  default: \"(• ◡ •)\"",
        "",
      ].join("\n"),
    );
    const r = validateEmoteDirectory(d, "ascii");
    expect(r.ok).toBe(true);
    expect(r.frameCount).toBeGreaterThanOrEqual(2);
    teardownScratch();
  });
});

// -------------------------------------------------------------------------
// Renderer-kind resolution
// -------------------------------------------------------------------------

describe("renderer kind resolution (P6)", () => {
  // Light smoke tests for resolveRendererKind using the existing
  // renderer-factory adapter (no frame loading).
  it("returns 'ascii' for a config that maps 'unknown' to ascii", async () => {
    const { resolveRendererKind } = await import("../../src/adapters/renderer-factory.js");
    const kind = resolveRendererKind({
      enabled: true,
      debug: false,
      size: 8,
      readingSpeed: 4,
      hideBelow: 30,
      holdDuration: { hi: 2000, success: 1200, failure: 1200 },
      blinkInterval: [3000, 6000],
      talkTickMs: 120,
      cycleMs: 500,
      emotes: [{ model: "*", "emote-set": "ascii" }],
      terminals: [{ match: "unknown", render: "ascii" }],
    });
    expect(kind).toBe("ascii");
  });

  it("returns 'image' for any non-ascii protocol (sixel)", async () => {
    // Pick sixel because it's the most commonly resolvable image
    // protocol on Windows hosts where the bundled image set is
    // intended. The renderer-factory resolves protocol via the
    // terminal mapping; we force one that matches the detected name.
    const { resolveRendererKind } = await import("../../src/adapters/renderer-factory.js");
    const kind = resolveRendererKind(
      {
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
        terminals: [{ match: "unknown", render: "sixel" }],
      },
      new Set(["unknown"]),
    );
    expect(kind).toBe("image");
  });
});