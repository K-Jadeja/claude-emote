import { describe, expect, it } from "vitest";
import {
  SESSION_LABEL_ENV,
  resolveSessionLabel,
} from "../../src/launcher/session-label.js";

describe("session label", () => {
  it("uses only the current directory basename by default", () => {
    expect(resolveSessionLabel("D:\\Workspace\\clients\\gp2", {})).toBe("gp2");
  });

  it("accepts a trimmed explicit label without exposing the cwd", () => {
    expect(
      resolveSessionLabel("D:\\secret\\client-project", {
        [SESSION_LABEL_ENV]: "  Greenpost editing  ",
      }),
    ).toBe("Greenpost editing");
  });

  it("hides the label only through the explicit privacy switch", () => {
    expect(
      resolveSessionLabel("D:\\Workspace\\gp2", {
        CLAUDE_EMOTE_HIDE_SESSION_LABEL: "1",
      }),
    ).toBeNull();
  });

  it("strips control characters, collapses whitespace, and truncates safely", () => {
    expect(
      resolveSessionLabel("D:\\Workspace\\gp2", {
        [SESSION_LABEL_ENV]: `  alpha\u0000   ${"x".repeat(80)}  `,
      }),
    ).toBe(`alpha ${"x".repeat(42)}`);
  });

  it("rejects a blank explicit label instead of silently inventing one", () => {
    expect(() =>
      resolveSessionLabel("D:\\Workspace\\gp2", {
        [SESSION_LABEL_ENV]: "   ",
      }),
    ).toThrow(/must contain a visible character/);
  });
});
