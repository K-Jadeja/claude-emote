import { describe, expect, it } from "vitest";
import { parseLauncherArgs } from "../../src/launcher/args.js";

describe("parseLauncherArgs", () => {
  it("defaults to desktop on Windows and terminal elsewhere", () => {
    expect(parseLauncherArgs(["--resume"], {}, "win32")).toEqual({
      renderer: "desktop",
      claudeArgs: ["--resume"],
    });
    expect(parseLauncherArgs(["--resume"], {}, "linux").renderer).toBe(
      "terminal",
    );
  });

  it("strips namespaced renderer flags without reordering Claude argv", () => {
    expect(
      parseLauncherArgs(
        ["--model", "opus", "--emote-renderer=desktop", "--resume"],
        {},
        "linux",
      ),
    ).toEqual({
      renderer: "desktop",
      claudeArgs: ["--model", "opus", "--resume"],
    });
  });

  it("forwards everything after the argument boundary", () => {
    expect(
      parseLauncherArgs(["--", "--emote-renderer=none"], {}, "win32"),
    ).toEqual({
      renderer: "desktop",
      claudeArgs: ["--", "--emote-renderer=none"],
    });
  });

  it("supports environment selection and the no-emote alias", () => {
    expect(
      parseLauncherArgs(["--no-emote", "--resume"], {
        CLAUDE_EMOTE_RENDERER: "desktop",
      }, "win32"),
    ).toEqual({ renderer: "none", claudeArgs: ["--resume"] });
  });

  it("keeps the legacy integration harness terminal-only", () => {
    expect(
      parseLauncherArgs([], { CLAUDE_EMOTE_TEST_MODE: "1" }, "win32").renderer,
    ).toBe("terminal");
  });

  it("fails clearly for invalid and conflicting wrapper flags", () => {
    expect(() =>
      parseLauncherArgs([], { CLAUDE_EMOTE_RENDERER: "magic" }, "win32"),
    ).toThrow(/CLAUDE_EMOTE_RENDERER must be desktop, terminal, or none/);
    expect(() =>
      parseLauncherArgs(
        ["--emote-renderer=desktop", "--no-emote"],
        {},
        "win32",
      ),
    ).toThrow(/conflicting/);
  });
});
