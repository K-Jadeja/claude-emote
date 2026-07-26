import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = resolve(process.cwd());
const BUILD_SCRIPT = join(
  PROJECT_ROOT,
  "scripts",
  "build-desktop-overlay.mjs",
);

describe("desktop overlay resource build", () => {
  it("validates assets, icon, and the resource/package directory boundary", () => {
    const result = spawnSync(process.execPath, [BUILD_SCRIPT], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      timeout: 15_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("[overlay] built 19 validated frames");
    expect(result.stdout).toContain("desktop\\resources");
    const faviconPath = join(
      PROJECT_ROOT,
      "desktop",
      "resources",
      "favicon.ico",
    );
    expect(existsSync(faviconPath)).toBe(true);
    const favicon = readFileSync(faviconPath);
    expect([...favicon.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
    expect(favicon.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(
      true,
    );
  });
});
