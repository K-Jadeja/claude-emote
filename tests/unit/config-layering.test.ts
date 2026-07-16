/**
 * config-layering.test.ts (P6 final repair)
 *
 * Regression for the loadLayeredConfig argument contract. The two
 * arguments have different meanings and must not be conflated:
 *
 *   extDir → the claude-emote package root containing bundled
 *            config.json (lowest-priority layer)
 *   cwd    → the user's current project containing the optional
 *            <cwd>/.claude-emote/extensions/claude-emote/config.json
 *            (highest-priority layer)
 *
 * Phase 6 final repair: avatar-process.ts previously passed
 * process.cwd() for both arguments. The tests below prove the
 * argument meanings and would fail under that incorrect call.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadLayeredConfig } from "../../src/core/config.js";
import { PACKAGE_ROOT } from "../../src/shared/project-paths.js";

let fakeExtensionRoot: string;
let fakeProjectCwd: string;

beforeAll(() => {
  fakeExtensionRoot = mkdtempSync(join(tmpdir(), "claude-emote-p6layer-ext-"));
  fakeProjectCwd = mkdtempSync(join(tmpdir(), "claude-emote-p6layer-proj-"));
  writeFileSync(
    join(fakeExtensionRoot, "config.json"),
    JSON.stringify({
      hideBelow: 17,
      terminals: [{ match: "unknown", render: "ascii" }],
    }),
  );
});

afterAll(() => {
  rmSync(fakeExtensionRoot, { recursive: true, force: true });
  rmSync(fakeProjectCwd, { recursive: true, force: true });
});

describe("loadLayeredConfig argument contract (P6)", () => {
  it("reads bundled config from the extension-dir argument", () => {
    const { config } = loadLayeredConfig(fakeExtensionRoot, fakeProjectCwd);
    expect(config.hideBelow).toBe(17);
    const unknown = config.terminals.find((t) => t.match === "unknown");
    expect(unknown).toBeDefined();
    expect(unknown?.render).toBe("ascii");
  });

  it("reads the project-level config from the cwd argument", () => {
    const projectConfigDir = join(
      fakeProjectCwd,
      ".claude-emote",
      "extensions",
      "claude-emote",
    );
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      join(projectConfigDir, "config.json"),
      JSON.stringify({
        holdDuration: { hi: 50, success: 1200, failure: 1200 },
      }),
    );
    const { config } = loadLayeredConfig(fakeExtensionRoot, fakeProjectCwd);
    // Project holdDuration.hi overrides extension's missing one.
    expect(config.holdDuration.hi).toBe(50);
  });

  it("project config overrides extension config when both are present", () => {
    // Re-write extension config to include holdDuration.hi too.
    writeFileSync(
      join(fakeExtensionRoot, "config.json"),
      JSON.stringify({
        hideBelow: 17,
        holdDuration: { hi: 999, success: 999, failure: 999 },
        terminals: [{ match: "unknown", render: "ascii" }],
      }),
    );
    // And the project config overrides it.
    const projectConfigDir = join(
      fakeProjectCwd,
      ".claude-emote",
      "extensions",
      "claude-emote",
    );
    writeFileSync(
      join(projectConfigDir, "config.json"),
      JSON.stringify({ holdDuration: { hi: 7, success: 1, failure: 1 } }),
    );
    const { config } = loadLayeredConfig(fakeExtensionRoot, fakeProjectCwd);
    expect(config.holdDuration.hi).toBe(7);
    expect(config.hideBelow).toBe(17);
  });

  it("regression: passing the same cwd for BOTH arguments loses the extension layer", () => {
    // This is exactly what avatar-process.ts was doing before the
    // P6 final repair. It must be wrong.
    // Use fakeProjectCwd as the "extension dir" too — fakeProjectCwd
    // does NOT contain a config.json (only a .claude-emote/.../config.json),
    // so the extension layer is empty. The bundled hideBelow=17 must
    // NOT appear, proving that the extension layer was lost.
    const { config } = loadLayeredConfig(fakeProjectCwd, fakeProjectCwd);
    // The .claude-emote/... layer is the PROJECT layer in this call,
    // not the extension layer. Extension config.json lives at
    // fakeProjectCwd/config.json which does not exist.
    expect(existsSync(join(fakeProjectCwd, "config.json"))).toBe(false);
    // The extension layer would normally carry hideBelow=17 — it does
    // NOT appear here because the wrong dir was passed.
    expect(config.hideBelow).not.toBe(17);
  });

  it("regression: avatar-process must use PACKAGE_ROOT for the extension argument", () => {
    // The shipped package config.json at <PACKAGE_ROOT>/config.json
    // declares `hideBelow: 20`. When avatar-process correctly passes
    // PACKAGE_ROOT as the extension argument, that setting shows up.
    // When it incorrectly passes cwd, the setting is lost.
    expect(existsSync(join(PACKAGE_ROOT, "config.json"))).toBe(true);
    const { config } = loadLayeredConfig(
      PACKAGE_ROOT,
      fakeProjectCwd,
    );
    // Bundled config.json declares hideBelow: 20.
    expect(config.hideBelow).toBe(20);
  });
});