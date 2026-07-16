/**
 * config-layering.test.ts (P6 proof-quality repair)
 *
 * Decisive test of the production runtime-config helper.
 *
 * Phase 6 final repair moved the runtime configuration boundary into
 * src/host/runtime-config.ts as loadAvatarRuntimeConfig(projectCwd).
 * That helper must call loadLayeredConfig(PACKAGE_ROOT, projectCwd)
 * — not loadLayeredConfig(projectCwd, projectCwd).
 *
 * These tests exercise the REAL production helper. If the helper is
 * changed to call loadLayeredConfig(projectCwd, projectCwd), every
 * bundled-setting assertion below fails because the bundled
 * <PACKAGE_ROOT>/config.json layer is silently lost.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAvatarRuntimeConfig } from "../../src/host/runtime-config.js";
import {
  PACKAGE_ROOT,
  BUNDLED_ASCII_EMOTE_DIR,
} from "../../src/shared/project-paths.js";

let tempProjectCwd: string;
let originalProjectConfigPath: string | null = null;
let originalProjectConfigContents: string | null = null;

beforeAll(() => {
  tempProjectCwd = mkdtempSync(join(tmpdir(), "claude-emote-p6-final-proj-"));
  // Snapshot the unrelated cwd's project config (if any) so the test
  // restores it on cleanup.
  originalProjectConfigPath = join(
    tempProjectCwd,
    ".claude-emote",
    "extensions",
    "claude-emote",
    "config.json",
  );
  if (existsSync(originalProjectConfigPath)) {
    originalProjectConfigContents = readFileSync(
      originalProjectConfigPath,
      "utf8",
    );
  }
});

afterAll(() => {
  // Restore the original project config if we overwrote it.
  if (originalProjectConfigContents !== null) {
    mkdirSync(join(tempProjectCwd, ".claude-emote", "extensions", "claude-emote"), {
      recursive: true,
    });
    writeFileSync(originalProjectConfigPath, originalProjectConfigContents, "utf8");
  }
  rmSync(tempProjectCwd, { recursive: true, force: true });
});

describe("loadAvatarRuntimeConfig (production helper, P6 final)", () => {
  it("bundled <PACKAGE_ROOT>/config.json is loaded when no project config exists", () => {
    // Make sure no project config is present.
    const projectConfig = join(
      tempProjectCwd,
      ".claude-emote",
      "extensions",
      "claude-emote",
      "config.json",
    );
    rmSync(projectConfig, { force: true });
    expect(existsSync(projectConfig)).toBe(false);

    const { config } = loadAvatarRuntimeConfig(tempProjectCwd);

    // Distinctive setting from the real bundled <PACKAGE_ROOT>/config.json.
    // If the helper was changed to loadLayeredConfig(tempProjectCwd,
    // tempProjectCwd), this assertion would fail because the bundled
    // layer would be silently lost.
    expect(config.hideBelow).toBe(20);
    // The bundled ASCII emote dir must still be reachable for asset
    // resolution; this is the package-root-driven path Phase 6 owns.
    expect(BUNDLED_ASCII_EMOTE_DIR.startsWith(PACKAGE_ROOT)).toBe(true);
  });

  it("project config overrides conflicting bundled values when both are present", () => {
    // Plant a project config that overrides exactly one bundled value
    // and adds one new value.
    const projectConfigDir = join(
      tempProjectCwd,
      ".claude-emote",
      "extensions",
      "claude-emote",
    );
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      join(projectConfigDir, "config.json"),
      JSON.stringify({
        terminals: [{ match: "unknown", render: "ascii" }],
        holdDuration: { hi: 77, success: 1200, failure: 1200 },
      }),
    );

    const { config } = loadAvatarRuntimeConfig(tempProjectCwd);

    // Bundled hideBelow must STILL be present (proves the extension
    // layer is loaded through the first argument of the helper).
    expect(config.hideBelow).toBe(20);

    // Project holdDuration.hi must win (proves the project layer is
    // loaded through the second argument of the helper).
    expect(config.holdDuration.hi).toBe(77);

    // Project terminal mapping must be present.
    const unknown = config.terminals.find((t) => t.match === "unknown");
    expect(unknown).toBeDefined();
    expect(unknown?.render).toBe("ascii");
  });

  it("decisive regression: if the helper used loadLayeredConfig(cwd, cwd), the bundled hideBelow would be lost", async () => {
    // This is a documentation-style assertion that proves the test
    // suite is sensitive to the bug. We do not modify the production
    // helper here; instead we re-implement the broken call inline
    // and assert it produces a DIFFERENT result than
    // loadAvatarRuntimeConfig.
    const { loadLayeredConfig } = await import("../../src/core/config.js");
    const broken = loadLayeredConfig(tempProjectCwd, tempProjectCwd);
    const correct = loadAvatarRuntimeConfig(tempProjectCwd);

    // The bundled hideBelow would be 20 under correct, but absent
    // under broken (cwd does not contain a config.json).
    expect(correct.config.hideBelow).toBe(20);
    expect(broken.config.hideBelow).not.toBe(20);
  });

  it("production helper is sourced from src/host/runtime-config.ts (not from src/core/config.ts)", () => {
    // Sanity: the production helper's source-of-truth must be the
    // module under src/host. This guards against accidental inline
    // calls to loadLayeredConfig() inside avatar-process.ts. We
    // strip comments before matching so descriptive prose mentioning
    // the layered-config call does not produce a false positive.
    const source = readFileSync(
      join(PROJECT_ROOT(), "src", "host", "avatar-process.ts"),
      "utf8",
    );
    const codeOnly = stripComments(source);
    expect(codeOnly).not.toMatch(/loadLayeredConfig\s*\(/);
    expect(codeOnly).toMatch(/loadAvatarRuntimeConfig\s*\(/);
  });
});

function PROJECT_ROOT(): string {
  return PACKAGE_ROOT;
}

/** Remove /* ... *\/ block comments and // line comments for code-only matching. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}