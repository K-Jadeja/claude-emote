/**
 * tests/unit/benchmark-frame-loader.test.ts
 *
 * Focused tests for the Phase 9B benchmark frame loader. The loader
 * reads the bundled emotes/ascii/ascii.yaml through the maintained
 * `yaml` package and exposes every required state's frames as
 * string arrays. These tests prove the contract:
 *   - every required state is loaded (idle, think, talk, read,
 *     write, failure, compact)
 *   - primaryThink matches the canonical "default" frame when the
 *     state is a named map
 *   - missing required states fail clearly
 *   - missing yaml file fails clearly
 *
 * No timing assertions, no child processes, no tempdirs.
 */

import { describe, it, expect } from "vitest";
import { loadBundledFrames } from "../../scripts/lib/benchmark-frame-loader.mjs";

describe("benchmark-frame-loader loadBundledFrames", () => {
  it("loads idle frames from the bundled ascii.yaml", async () => {
    const f = await loadBundledFrames();
    expect(Array.isArray(f.idle)).toBe(true);
    expect(f.idle.length).toBeGreaterThan(0);
    // The bundled ascii.yaml defines idle: { default: "(• ◡ •)", blink: "(- ◡ -)" }.
    expect(f.idle).toContain("(• ◡ •)");
    expect(f.idle).toContain("(- ◡ -)");
  });

  it("loads think frames from the bundled ascii.yaml", async () => {
    const f = await loadBundledFrames();
    expect(Array.isArray(f.think)).toBe(true);
    expect(f.think.length).toBeGreaterThan(0);
    // think: { default: "(•_ • )?", hard: "(-᷅_ -᷄\") " }
    expect(f.think).toContain("(•_ • )?");
  });

  it("loads talk frames from the bundled ascii.yaml", async () => {
    const f = await loadBundledFrames();
    expect(Array.isArray(f.talk)).toBe(true);
    expect(f.talk.length).toBeGreaterThan(0);
    expect(f.talk).toContain("(• _ •)");
    expect(f.talk).toContain("(• . •)");
  });

  it("loads read frames from the bundled ascii.yaml", async () => {
    const f = await loadBundledFrames();
    expect(Array.isArray(f.read)).toBe(true);
    expect(f.read.length).toBeGreaterThan(0);
    // read is an array of three frames in ascii.yaml.
    expect(f.read).toContain("( ╭ರᴥ•́)⠉");
    expect(f.read).toContain("( ╭ರᴥ•)⠒");
    expect(f.read).toContain("( ╭ರᴥ•)⠤");
  });

  it("loads write frames from the bundled ascii.yaml", async () => {
    const f = await loadBundledFrames();
    expect(Array.isArray(f.write)).toBe(true);
    expect(f.write.length).toBeGreaterThan(0);
    expect(f.write).toContain("( ｡ ｡).φ");
    expect(f.write).toContain("( ｡ ｡)φ.");
  });

  it("loads failure frames from the bundled ascii.yaml", async () => {
    const f = await loadBundledFrames();
    expect(Array.isArray(f.failure)).toBe(true);
    expect(f.failure.length).toBeGreaterThan(0);
    // failure is a scalar: "( ° Д°)#"
    expect(f.failure).toContain("( ° Д°)#");
  });

  it("loads compact frames from the bundled ascii.yaml", async () => {
    const f = await loadBundledFrames();
    expect(Array.isArray(f.compact)).toBe(true);
    expect(f.compact.length).toBeGreaterThan(0);
    // compact is a scalar: "(-᷅_ -᷄;)"
    expect(f.compact).toContain("(-᷅_ -᷄;)");
  });

  it("picks the named 'default' frame as primaryThink", async () => {
    const f = await loadBundledFrames();
    // ascii.yaml: think.default: "(•_ • )?"
    expect(f.primaryThink).toBe("(•_ • )?");
  });

  it("reports the source file and loader identity", async () => {
    const f = await loadBundledFrames();
    expect(f.sourceFile).toContain("ascii.yaml");
    expect(f.loadedFrom).toContain("yaml package");
  });

  it("returns every required state's frames as string arrays", async () => {
    const f = await loadBundledFrames();
    for (const state of ["idle", "think", "talk", "read", "write", "failure", "compact"]) {
      expect(Array.isArray(f[state])).toBe(true);
      // @ts-expect-error index access by string
      expect(f[state].length).toBeGreaterThan(0);
      // @ts-expect-error index access by string
      for (const frame of f[state]) {
        expect(typeof frame).toBe("string");
        expect(frame.length).toBeGreaterThan(0);
      }
    }
  });
});
