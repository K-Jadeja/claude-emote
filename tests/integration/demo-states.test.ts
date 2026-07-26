import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = resolve(process.cwd());
const DEMO_SCRIPT = join(PROJECT_ROOT, "scripts", "demo-states.mjs");

describe("standalone state demo", () => {
  it("renders the complete sequence without recursive frame lookup", () => {
    const result = spawnSync(process.execPath, [DEMO_SCRIPT], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        CLAUDE_EMOTE_DEMO_EMOTE_SET: "ascii",
        CLAUDE_EMOTE_DEMO_PROTOCOL: "ascii",
        CLAUDE_EMOTE_DEMO_DURATION_SCALE: "0.01",
        NO_COLOR: "1",
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("Maximum call stack size exceeded");
    for (const state of [
      "hi",
      "idle",
      "think",
      "talk",
      "read",
      "write",
      "tool",
      "failure",
      "compact",
    ]) {
      expect(result.stderr).toContain(`[demo] -> ${state}`);
    }
    expect(result.stderr).toContain("[demo] done.");
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});
