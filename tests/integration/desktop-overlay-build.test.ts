import { spawnSync } from "node:child_process";
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
  });
});
