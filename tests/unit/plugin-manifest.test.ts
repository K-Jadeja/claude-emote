import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("third-party plugin identity", () => {
  it("uses a name accepted by current Claude Code rather than a reserved vendor prefix", () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), ".claude-plugin", "plugin.json"), "utf8"),
    );
    expect(manifest.name).toBe("emote-companion");
    expect(manifest.name).not.toMatch(/^(claude-|anthropic-|anthropics-|cc-plugin-)/);
    expect(manifest.name).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});
