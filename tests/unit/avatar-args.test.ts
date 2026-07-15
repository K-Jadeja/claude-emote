/**
 * avatar-args.test.ts (P4 unit)
 *
 * Pure-function tests for the avatar process argument parser. Covers both
 * --flag=value and --flag value forms, CLI > env > default priority, and
 * graceful fallback to env when a flag is missing.
 */

import { describe, it, expect } from "vitest";
import { parseCliArgs, resolveAvatarConfig } from "../../src/host/avatar-args.js";

describe("parseCliArgs (P4)", () => {
  describe("--flag=value form", () => {
    it("parses --port=1234", () => {
      expect(parseCliArgs(["--port=1234"])).toEqual({ port: 1234 });
    });
    it("parses --instance=abc", () => {
      expect(parseCliArgs(["--instance=abc"])).toEqual({ instanceId: "abc" });
    });
    it("parses --emoteDir=path", () => {
      expect(parseCliArgs(["--emoteDir=D:/emotes"])).toEqual({
        emoteDir: "D:/emotes",
      });
    });
    it("parses --parentPid=999", () => {
      expect(parseCliArgs(["--parentPid=999"])).toEqual({ parentPid: 999 });
    });
    it("parses all four together in any order", () => {
      expect(
        parseCliArgs([
          "--port=51234",
          "--instance=test",
          "--emoteDir=D:/emotes",
          "--parentPid=42",
        ]),
      ).toEqual({
        port: 51234,
        instanceId: "test",
        emoteDir: "D:/emotes",
        parentPid: 42,
      });
    });
  });

  describe("--flag value form (two-arg)", () => {
    it("parses --port 1234", () => {
      expect(parseCliArgs(["--port", "1234"])).toEqual({ port: 1234 });
    });
    it("parses --instance abc", () => {
      expect(parseCliArgs(["--instance", "abc"])).toEqual({ instanceId: "abc" });
    });
    it("parses --emoteDir D:/emotes", () => {
      expect(parseCliArgs(["--emoteDir", "D:/emotes"])).toEqual({
        emoteDir: "D:/emotes",
      });
    });
    it("parses --parentPid 42", () => {
      expect(parseCliArgs(["--parentPid", "42"])).toEqual({ parentPid: 42 });
    });
  });

  describe("edge cases", () => {
    it("returns an empty object for empty argv", () => {
      expect(parseCliArgs([])).toEqual({});
    });
    it("ignores unknown flags", () => {
      expect(parseCliArgs(["--unknown=foo", "--port=1"])).toEqual({ port: 1 });
    });
    it("ignores non-numeric values for numeric flags (falls back to env/default)", () => {
      // We do not throw; the value is silently dropped from the CLI result.
      expect(parseCliArgs(["--port=abc"]).port).toBeUndefined();
      expect(parseCliArgs(["--port", "abc"]).port).toBeUndefined();
    });
    it("does not consume a flag-looking value after --flag (treated as missing)", () => {
      // If the user writes `--port --instance=99`, we treat `--instance=99`
      // as the next flag (not as --port's value, since it starts with --).
      // --port therefore has no CLI value and falls back to env/default.
      // The next iteration parses `--instance=99` as a separate flag.
      expect(parseCliArgs(["--port", "--instance=99"])).toEqual({
        instanceId: "99",
      });
    });
  });
});

describe("resolveAvatarConfig (P4) — CLI > env > default", () => {
  it("uses CLI value when supplied", () => {
    const { config } = resolveAvatarConfig(
      ["--port=1234", "--instance=cli"],
      { CLAUDE_EMOTE_PORT: "9999", CLAUDE_EMOTE_INSTANCE_ID: "env" },
    );
    expect(config.port).toBe(1234);
    expect(config.instanceId).toBe("cli");
  });

  it("uses env value when CLI is absent", () => {
    const { config } = resolveAvatarConfig([], {
      CLAUDE_EMOTE_PORT: "8080",
      CLAUDE_EMOTE_INSTANCE_ID: "from-env",
      CLAUDE_EMOTE_EMOTE_DIR: "D:/emotes",
      CLAUDE_EMOTE_PARENT_PID: "777",
    });
    expect(config.port).toBe(8080);
    expect(config.instanceId).toBe("from-env");
    expect(config.emoteDir).toBe("D:/emotes");
    expect(config.parentPid).toBe(777);
  });

  it("uses defaults when neither CLI nor env is present", () => {
    const { config } = resolveAvatarConfig([], {});
    expect(config.port).toBe(0);
    expect(config.instanceId).toBe("");
    expect(config.emoteDir).toBeNull();
    expect(config.parentPid).toBe(0);
  });

  it("CLI takes precedence over env even for the two-arg form", () => {
    const { config } = resolveAvatarConfig(
      ["--port", "5555"],
      { CLAUDE_EMOTE_PORT: "1111" },
    );
    expect(config.port).toBe(5555);
  });

  it("CLI takes precedence over env for emoteDir and parentPid", () => {
    const { config } = resolveAvatarConfig(
      ["--emoteDir=cli-dir", "--parentPid=42"],
      { CLAUDE_EMOTE_EMOTE_DIR: "env-dir", CLAUDE_EMOTE_PARENT_PID: "99" },
    );
    expect(config.emoteDir).toBe("cli-dir");
    expect(config.parentPid).toBe(42);
  });

  it("returns unknown flags in the unknown[] list", () => {
    const { unknown } = resolveAvatarConfig(
      ["--port=1", "--bogus=2", "--instance=x", "--another"],
      {},
    );
    expect(unknown).toEqual(["--bogus=2", "--another"]);
  });

  it("ignores invalid numeric env vars (uses default)", () => {
    const { config } = resolveAvatarConfig([], {
      CLAUDE_EMOTE_PORT: "not-a-number",
      CLAUDE_EMOTE_PARENT_PID: "also-not",
    });
    expect(config.port).toBe(0);
    expect(config.parentPid).toBe(0);
  });
});