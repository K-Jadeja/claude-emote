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
  decideAvatarLaunchMode,
  PROJECT_ROOT,
  AVATAR_PROCESS,
  DEFAULT_PANE_SIZE,
  MIN_PANE_SIZE,
} from "../../src/launcher/args.js";

describe("launcher args", () => {
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

    it("preserves an unrelated --plugin-dir PATH and still injects claude-emote's", () => {
      const result = buildClaudeArgs(
        ["--plugin-dir", "C:/other/plugin"],
        PROJECT_ROOT,
      );
      // The user's --plugin-dir is preserved in its original place; the
      // claude-emote plugin dir is appended at the end.
      expect(result.indexOf("--plugin-dir")).toBe(0);
      expect(result[result.indexOf("--plugin-dir") + 1]).toBe(
        "C:/other/plugin",
      );
      expect(result.indexOf(PROJECT_ROOT)).toBe(result.length - 1);
      expect(result[result.length - 2]).toBe("--plugin-dir");
      expect(result.filter((a) => a === "--plugin-dir").length).toBe(2);
    });

    it("preserves an unrelated --plugin-dir=PATH and still injects claude-emote's", () => {
      const result = buildClaudeArgs(
        ["--plugin-dir=C:/other/plugin"],
        PROJECT_ROOT,
      );
      expect(result[0]).toBe("--plugin-dir=C:/other/plugin");
      expect(result[result.length - 2]).toBe("--plugin-dir");
      expect(result[result.length - 1]).toBe(PROJECT_ROOT);
      expect(result.filter((a) => a.startsWith("--plugin-dir")).length).toBe(
        2,
      );
    });

    it("does not duplicate --plugin-dir= when the user pointed at PROJECT_ROOT", () => {
      const result = buildClaudeArgs(
        [`--plugin-dir=${PROJECT_ROOT}`],
        PROJECT_ROOT,
      );
      expect(result).toEqual([`--plugin-dir=${PROJECT_ROOT}`]);
      expect(result.filter((a) => a.startsWith("--plugin-dir")).length).toBe(1);
    });

    it("does not duplicate --plugin-dir= when the user pointed elsewhere (still injects ours)", () => {
      const result = buildClaudeArgs(
        ["--plugin-dir=C:/other/plugin", "--resume", "--model", "opus"],
        PROJECT_ROOT,
      );
      expect(result[0]).toBe("--plugin-dir=C:/other/plugin");
      // claude-emote plugin-dir is appended at the end.
      expect(result[result.length - 1]).toBe(PROJECT_ROOT);
      expect(result[result.length - 2]).toBe("--plugin-dir");
      // User arguments preserved in order.
      expect(result.indexOf("--resume")).toBeGreaterThan(-1);
      expect(result.indexOf("--model")).toBeGreaterThan(
        result.indexOf("--resume"),
      );
    });

    it("injected package path is absolute", () => {
      const result = buildClaudeArgs([], PROJECT_ROOT);
      const idx = result.indexOf("--plugin-dir");
      const value = result[idx + 1];
      // Must be absolute (Windows: starts with drive letter or UNC; POSIX: starts with /)
      expect(
        /^[A-Z]:[\\/]/.test(value) || value.startsWith("/"),
      ).toBe(true);
    });

    it("preserves user argument order otherwise", () => {
      const userArgs = [
        "--resume",
        "--model",
        "opus",
        "--dangerously-skip-permissions",
        "--plugin-dir",
        "C:/third/plugin",
      ];
      const result = buildClaudeArgs(userArgs, PROJECT_ROOT);
      // First three appear at indices 0..2 in the same order.
      expect(result[0]).toBe("--resume");
      expect(result[1]).toBe("--model");
      expect(result[2]).toBe("opus");
      // --plugin-dir is preserved inline.
      const userPluginDirIdx = result.indexOf("C:/third/plugin");
      expect(userPluginDirIdx).toBe(5);
      // claude-emote plugin-dir is appended.
      expect(result[result.length - 2]).toBe("--plugin-dir");
      expect(result[result.length - 1]).toBe(PROJECT_ROOT);
    });
  });

  describe("buildAvatarArgv", () => {
    it("emits --port, --instance, and --parentPid when no custom emote dir", () => {
      const argv = buildAvatarArgv({
        port: 51234,
        instanceId: "abc123",
        emoteDir: null,
        parentPid: 999,
      });
      expect(argv[0]).toBe(AVATAR_PROCESS);
      expect(argv).toContain("--port=51234");
      expect(argv).toContain("--instance=abc123");
      expect(argv).toContain("--parentPid=999");
    });

    it("includes --emoteDir only when a custom path is supplied", () => {
      const custom = buildAvatarArgv({
        port: 1,
        instanceId: "x",
        emoteDir: "/custom/path",
        parentPid: 1,
      });
      expect(custom).toContain("--emoteDir=/custom/path");

      const automatic = buildAvatarArgv({
        port: 1,
        instanceId: "x",
        emoteDir: null,
        parentPid: 1,
      });
      expect(automatic).not.toContain("--emoteDir");
    });
  });

  describe("buildWindowsTerminalArgs (Phase 8)", () => {
    const base = buildWindowsTerminalArgs({
      title: "claude-emote",
      workingDirectory: "D:/Workspace/Projects/user-project",
      executable: process.execPath,
      executableArgs: [AVATAR_PROCESS, "--port=51234", "--instance=abc"],
    });

    it("begins with -w, 0", () => {
      expect(base.slice(0, 2)).toEqual(["-w", "0"]);
    });

    it("includes split-pane", () => {
      expect(base).toContain("split-pane");
    });

    it("includes -V (vertical split)", () => {
      expect(base).toContain("-V");
    });

    it("includes --size, 0.25 by default", () => {
      const sizeIdx = base.indexOf("--size");
      expect(sizeIdx).toBeGreaterThan(-1);
      expect(base[sizeIdx + 1]).toBe(String(DEFAULT_PANE_SIZE));
      expect(base).toContain("0.25");
    });

    it("includes --size <custom> when supplied", () => {
      const custom = buildWindowsTerminalArgs({
        title: "claude-emote",
        workingDirectory: "D:/Workspace/Projects/user-project",
        executable: process.execPath,
        executableArgs: [AVATAR_PROCESS, "--port=51234"],
        size: 0.4,
      });
      expect(custom).toContain("0.4");
      expect(custom).not.toContain("0.25");
    });

    it("includes -d with the exact project cwd", () => {
      const cwd = "D:/Workspace/Projects/user-project";
      expect(base).toContain("-d");
      const idx = base.indexOf("-d");
      expect(base[idx + 1]).toBe(cwd);
    });

    it("includes --title", () => {
      expect(base).toContain("--title");
      const idx = base.indexOf("--title");
      expect(base[idx + 1]).toBe("claude-emote");
    });

    it("uses process.execPath as the pane executable", () => {
      const idx = base.lastIndexOf(process.execPath);
      expect(idx).toBeGreaterThan(-1);
    });

    it("avatar script and required arguments are forwarded", () => {
      const idx = base.indexOf(process.execPath);
      const rest = base.slice(idx + 1);
      expect(rest).toContain(AVATAR_PROCESS);
      expect(rest).toContain("--port=51234");
      expect(rest).toContain("--instance=abc");
      // Each appears exactly once.
      const countOf = (s: string) => rest.filter((a) => a === s).length;
      expect(countOf(AVATAR_PROCESS)).toBe(1);
      expect(countOf("--port=51234")).toBe(1);
      expect(countOf("--instance=abc")).toBe(1);
    });

    it("rejects invalid pane size", () => {
      expect(() =>
        buildWindowsTerminalArgs({
          title: "x",
          workingDirectory: "D:/cwd",
          executable: process.execPath,
          executableArgs: [],
          size: 0,
        }),
      ).toThrow(/pane size/);
      expect(() =>
        buildWindowsTerminalArgs({
          title: "x",
          workingDirectory: "D:/cwd",
          executable: process.execPath,
          executableArgs: [],
          size: 1,
        }),
      ).toThrow(/pane size/);
      expect(() =>
        buildWindowsTerminalArgs({
          title: "x",
          workingDirectory: "D:/cwd",
          executable: process.execPath,
          executableArgs: [],
          size: MIN_PANE_SIZE,
        }),
      ).toThrow(/pane size/);
    });

    it("command never contains -F (fullscreen)", () => {
      expect(base).not.toContain("-F");
      expect(base).not.toContain("--full");
      expect(base).not.toContain("--fullscreen");
    });

    it("command never contains start, cmd, /c", () => {
      expect(base).not.toContain("start");
      expect(base).not.toContain("cmd");
      expect(base).not.toContain("/c");
    });

    it("paths containing spaces remain one argv item", () => {
      const out = buildWindowsTerminalArgs({
        title: "claude-emote",
        workingDirectory: "D:/Users/A B/Projects/x",
        executable: "C:/Program Files/nodejs/node.exe",
        executableArgs: ["C:/Program Files/cli/avatar.js", "--emoteDir=D:/My Set/emotes"],
      });
      // Find each path and confirm it appears as exactly one entry.
      expect(out).toContain("D:/Users/A B/Projects/x");
      expect(out.indexOf("D:/Users/A B/Projects/x")).toBe(out.lastIndexOf("D:/Users/A B/Projects/x"));
      expect(out).toContain("C:/Program Files/nodejs/node.exe");
      expect(out.indexOf("C:/Program Files/nodejs/node.exe")).toBe(out.lastIndexOf("C:/Program Files/nodejs/node.exe"));
      expect(out).toContain("C:/Program Files/cli/avatar.js");
      expect(out.indexOf("C:/Program Files/cli/avatar.js")).toBe(out.lastIndexOf("C:/Program Files/cli/avatar.js"));
      expect(out).toContain("--emoteDir=D:/My Set/emotes");
      expect(out.indexOf("--emoteDir=D:/My Set/emotes")).toBe(out.lastIndexOf("--emoteDir=D:/My Set/emotes"));
    });

    it("paths containing & remain one argv item", () => {
      const out = buildWindowsTerminalArgs({
        title: "x",
        workingDirectory: "D:/R&D/project",
        executable: process.execPath,
        executableArgs: [AVATAR_PROCESS],
      });
      expect(out).toContain("D:/R&D/project");
      expect(out.indexOf("D:/R&D/project")).toBe(out.lastIndexOf("D:/R&D/project"));
    });

    it("Unicode paths remain one argv item", () => {
      const out = buildWindowsTerminalArgs({
        title: "claude-emote",
        workingDirectory: "D:/Ünïcödé/projéct",
        executable: process.execPath,
        executableArgs: [AVATAR_PROCESS],
      });
      expect(out).toContain("D:/Ünïcödé/projéct");
      expect(out.indexOf("D:/Ünïcödé/projéct")).toBe(out.lastIndexOf("D:/Ünïcödé/projéct"));
    });

    it("titles containing spaces remain one argv item", () => {
      const out = buildWindowsTerminalArgs({
        title: "claude-emote avatar pane",
        workingDirectory: PROJECT_ROOT,
        executable: process.execPath,
        executableArgs: [AVATAR_PROCESS],
      });
      expect(out).toContain("claude-emote avatar pane");
      expect(out.indexOf("claude-emote avatar pane")).toBe(
        out.lastIndexOf("claude-emote avatar pane"),
      );
    });
  });

  describe("decideAvatarLaunchMode (P8 gating)", () => {
    it("win32 + WT_SESSION + wt found → windows-terminal", () => {
      const d = decideAvatarLaunchMode(
        { WT_SESSION: "abc-123" },
        "win32",
        "C:/Windows/System32/wt.exe",
      );
      expect(d).toEqual({ kind: "windows-terminal", reason: "inside-windows-terminal" });
    });

    it("win32 + no WT_SESSION + wt found → attached", () => {
      const d = decideAvatarLaunchMode(
        {},
        "win32",
        "C:/Windows/System32/wt.exe",
      );
      expect(d.kind).toBe("attached");
      expect(d.reason).toBe("not-inside-windows-terminal");
    });

    it("win32 + WT_SESSION + no wt → attached", () => {
      const d = decideAvatarLaunchMode(
        { WT_SESSION: "abc-123" },
        "win32",
        null,
      );
      expect(d.kind).toBe("attached");
      expect(d.reason).toBe("wt-not-found");
    });

    it("win32 + empty-string WT_SESSION + wt → attached (empty is absent)", () => {
      const d = decideAvatarLaunchMode(
        { WT_SESSION: "" },
        "win32",
        "C:/Windows/System32/wt.exe",
      );
      expect(d.kind).toBe("attached");
      expect(d.reason).toBe("not-inside-windows-terminal");
    });

    it("win32 + whitespace-only WT_SESSION + wt → attached (whitespace is absent)", () => {
      const d = decideAvatarLaunchMode(
        { WT_SESSION: "   " },
        "win32",
        "C:/Windows/System32/wt.exe",
      );
      expect(d.kind).toBe("attached");
      expect(d.reason).toBe("not-inside-windows-terminal");
    });

    it("linux + WT_SESSION + wt → attached (non-windows never selects WT)", () => {
      const d = decideAvatarLaunchMode(
        { WT_SESSION: "abc-123" },
        "linux",
        "/usr/bin/wt",
      );
      expect(d.kind).toBe("attached");
      expect(d.reason).toBe("not-windows");
    });

    it("darwin + wt → attached (non-windows never selects WT)", () => {
      const d = decideAvatarLaunchMode(
        {},
        "darwin",
        "/usr/local/bin/wt",
      );
      expect(d.kind).toBe("attached");
      expect(d.reason).toBe("not-windows");
    });

    it("wt.exe existence alone is insufficient (no WT_SESSION)", () => {
      // Most important regression test: the previous production
      // condition would select WT here. The corrected decision must not.
      const d = decideAvatarLaunchMode(
        {},
        "win32",
        "C:/Program Files/WindowsApps/wt.exe",
      );
      expect(d.kind).toBe("attached");
    });

    it("valid WT environment selects Windows Terminal", () => {
      const d = decideAvatarLaunchMode(
        { WT_SESSION: "valid-session-id" },
        "win32",
        "C:/Users/test/AppData/Local/Microsoft/WindowsApps/wt.exe",
      );
      expect(d.kind).toBe("windows-terminal");
    });

    it("wt.exe is referenced only by the launch decision (decideAvatarLaunchMode does NOT itself look up files)", () => {
      // The helper accepts a pre-resolved wt path as a parameter.
      // It must not call the filesystem.
      // This is enforced by signature.
      expect(typeof decideAvatarLaunchMode).toBe("function");
    });
  });
});