import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = resolve(process.cwd());
const CLI = join(
  PROJECT_ROOT,
  "node_modules",
  "@neutralinojs",
  "neu",
  "bin",
  "neu.js",
);

describe("pinned Neutralino CLI", () => {
  it("starts under the repository Node version", () => {
    const result = spawnSync(process.execPath, [CLI, "--help"], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: neu");
    expect(result.stderr).not.toContain("ERR_REQUIRE_ESM");
  }, 15_000);
});
