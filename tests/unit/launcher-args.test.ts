/**
 * launcher-args.test.ts
 *
 * Pure-function tests for the launcher's argv-construction helpers.
 * These run without spawning any subprocesses.
 */

import { describe, it, expect } from "vitest";
import {
  isVersionArgv,
  buildClaudeArgs,
  buildAvatarArgv,
  buildWindowsTerminalArgs,
  buildCmdLine,
  PROJECT_ROOT,
  AVATAR_PROCESS,
} from "../../src/launcher/args.js";

describe("launcher args (P3, P4, P8)", () => {
  describe("isVersionArgv", () => {
    it("returns true for --version", () => {
      expect(isVersionArgv(["--version"])).toBe(true);
    });
    it("returns true for -v", () => {
      expect(isVersionArgv(["-v"])).toBe(true);
    });
    it("returns false for unrelated args", () => {
      expect(isVersionArgv(["--resume", "--model", "opus"])).toBe(false);
    });
  });

  describe("buildClaudeArgs", () => {
    it("injects --plugin-dir at the end when the user didn't provide one", () => {
      const result = buildClaudeArgs(["--resume"], PROJECT_ROOT);
      expect(result).toEqual(["--resume", "--plugin-dir", PROJECT_ROOT]);
    });

    it("preserves user arguments in their original order", () => {
      const result = buildClaudeArgs(
        ["--resume", "--model", "opus", "--dangerously-skip-permissions"],
        PROJECT_ROOT,
      );
      expect(result).toEqual([
        "--resume",
        "--model",
        "opus",
        "--dangerously-skip-permissions",
        "--plugin-dir",
        PROJECT_ROOT,
      ]);
    });

    it("does not add a second --plugin-dir when the user already passed one pointing at PROJECT_ROOT", () => {
      const result = buildClaudeArgs(
        ["--plugin-dir", PROJECT_ROOT],
        PROJECT_ROOT,
      );
      expect(result).toEqual(["--plugin-dir", PROJECT_ROOT]);
      expect(result.filter((a) => a === "--plugin-dir").length).toBe(1);
    });

    it("preserves an unrelated --plugin-dir AND still injects claude-emote's plugin-dir", () => {
      // The user is loading some other plugin. claude-emote's plugin
      // must still be injected.
      const result = buildClaudeArgs(
        ["--plugin-dir", "C:/other/plugin"],
        PROJECT_ROOT,
      );
      expect(result).toEqual([
        "--plugin-dir",
        "C:/other/plugin",
        "--plugin-dir",
        PROJECT_ROOT,
      ]);
      expect(result.filter((a) => a === "--plugin-dir").length).toBe(2);
    });

    it("does not duplicate --plugin-dir when the user passed the = form pointing at PROJECT_ROOT", () => {
      const result = buildClaudeArgs(
        [`--plugin-dir=${PROJECT_ROOT}`],
        PROJECT_ROOT,
      );
      expect(result).toEqual([`--plugin-dir=${PROJECT_ROOT}`]);
      expect(result.filter((a) => a.startsWith("--plugin-dir")).length).toBe(1);
    });

    it("preserves an unrelated --plugin-dir= and still injects claude-emote's plugin-dir", () => {
      const result = buildClaudeArgs(
        ["--plugin-dir=C:/other/plugin"],
        PROJECT_ROOT,
      );
      expect(result).toEqual([
        "--plugin-dir=C:/other/plugin",
        "--plugin-dir",
        PROJECT_ROOT,
      ]);
    });

    it("uses the absolute resolved plugin dir", () => {
      const result = buildClaudeArgs([], PROJECT_ROOT);
      const idx = result.indexOf("--plugin-dir");
      expect(result[idx + 1]).toBe(PROJECT_ROOT);
    });
  });

  describe("buildAvatarArgv", () => {
    it("emits --port, --instance, --emoteDir, --parentPid", () => {
      const argv = buildAvatarArgv({
        port: 51234,
        instanceId: "abc123",
        emoteDir: "/path/to/emotes",
        parentPid: 999,
      });
      expect(argv[0]).toBe(AVATAR_PROCESS);
      expect(argv).toContain("--port=51234");
      expect(argv).toContain("--instance=abc123");
      expect(argv).toContain("--emoteDir=/path/to/emotes");
      expect(argv).toContain("--parentPid=999");
    });
  });

  describe("buildWindowsTerminalArgs (P8)", () => {
    const args = buildWindowsTerminalArgs({
      paneArgs: ["node", AVATAR_PROCESS, "--port=51234"],
      workingDir: PROJECT_ROOT,
    });

    it("targets the current window with -w 0", () => {
      expect(args).toContain("-w");
      expect(args).toContain("0");
    });

    it("uses split-pane", () => {
      expect(args).toContain("split-pane");
    });

    it("splits vertically with -V", () => {
      expect(args).toContain("-V");
    });

    it("uses --size 0.25 by default", () => {
      expect(args).toContain("--size");
      expect(args).toContain("0.25");
    });

    it("never emits -F (fullscreen)", () => {
      expect(args).not.toContain("-F");
      expect(args).not.toContain("--full");
      expect(args).not.toContain("--fullscreen");
    });

    it("includes the working directory with -d", () => {
      expect(args).toContain("-d");
      expect(args).toContain(PROJECT_ROOT);
    });

    it("runs the inner command via cmd /c", () => {
      expect(args).toContain("cmd");
      expect(args).toContain("/c");
    });

    it("uses an explicit --title", () => {
      expect(args).toContain("--title");
    });

    it("respects a custom --size when provided", () => {
      const custom = buildWindowsTerminalArgs({
        paneArgs: ["node"],
        size: 0.4,
      });
      expect(custom).toContain("0.4");
      expect(custom).not.toContain("0.25");
    });
  });

  describe("buildCmdLine", () => {
    it("joins simple args with spaces", () => {
      expect(buildCmdLine(["node", "a.js", "--port=1"])).toBe(
        "node a.js --port=1",
      );
    });
    it("quotes paths with spaces and preserves them in the output", () => {
      const cmd = buildCmdLine(["node", "C:/Program Files/app.js", "--port=1"]);
      // The path with a space is wrapped in double quotes.
      expect(cmd).toBe('node "C:/Program Files/app.js" --port=1');
    });
    it("escapes embedded double quotes", () => {
      const cmd = buildCmdLine(['echo', 'a"b']);
      // Embedded double quotes are backslash-escaped.
      expect(cmd).toBe('echo "a\\"b"');
    });
  });
});
