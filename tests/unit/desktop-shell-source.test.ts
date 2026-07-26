import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = resolve(process.cwd());

describe("desktop native shell configuration", () => {
  it("allows DPI-aware window sizing and keeps the design dimensions explicit", () => {
    const config = JSON.parse(
      readFileSync(
        join(PROJECT_ROOT, "desktop", "neutralino.config.json"),
        "utf8",
      ),
    );
    const source = readFileSync(
      join(PROJECT_ROOT, "desktop", "src", "shell.ts"),
      "utf8",
    );

    expect(config.nativeAllowList).toContain("window.getSize");
    expect(config.nativeAllowList).toContain("window.setSize");
    expect(config.cli.resourcesPath).toBe("/resources/");
    expect(config.modes.window.icon).toMatch(/^\/resources\/assets\//);
    expect(config.modes.window.enableInspector).toBe(false);
    expect(source).toContain("globalThis.devicePixelRatio");
    expect(source).toContain("DESIGN_WIDTH * displayScale");
    expect(source).toContain("DESIGN_HEIGHT * displayScale");
  });
});
