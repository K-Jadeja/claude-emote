import { describe, expect, it } from "vitest";
import {
  buildDesktopOverlaySpawnSpec,
  resolveDesktopOverlay,
} from "../../src/launcher/desktop-overlay.js";

const TOKEN = "A".repeat(43);

describe("desktop overlay resolution", () => {
  it("prefers the packaged Windows runtime and resource archive", () => {
    const root = "C:\\pkg";
    const found = resolveDesktopOverlay({}, "win32", "x64", root, (path) =>
      path.includes("desktop") && (
        path.endsWith("claude-pet-win_x64.exe") ||
        path.endsWith("resources.neu")
      ),
    );
    expect(found.kind).toBe("packaged");
    expect(found.args).toEqual([]);
  });

  it("uses current Neutralino directory-mode arguments for development", () => {
    const found = resolveDesktopOverlay({}, "win32", "x64", "C:\\repo", (path) =>
      path.includes("desktop") && (
        path.endsWith("neutralino-win_x64.exe") ||
        path.endsWith("resources\\index.html")
      ),
    );
    expect(found.kind).toBe("development");
    expect(found.args).toContain("--res-mode=directory");
    expect(found.args.some((arg) => arg.startsWith("--path="))).toBe(true);
  });

  it("fails clearly on unsupported production platforms", () => {
    expect(() =>
      resolveDesktopOverlay({}, "linux", "x64", "/pkg", () => false),
    ).toThrow(/not packaged for linux\/x64/);
  });

  it("passes endpoint and capability only through child environment", () => {
    const command = {
      executable: process.execPath,
      args: ["fake-overlay.js"],
      cwd: "C:\\tmp",
      kind: "override" as const,
    };
    const spec = buildDesktopOverlaySpawnSpec(
      command,
      {},
      "http://127.0.0.1:3210/event",
      TOKEN,
      "gp2",
    );
    expect(spec.args.join(" ")).not.toContain(TOKEN);
    expect(spec.args.join(" ")).not.toContain("3210");
    expect(spec.options.env?.CLAUDE_EMOTE_ENDPOINT).toContain("3210");
    expect(spec.options.env?.CLAUDE_EMOTE_CAPABILITY_TOKEN).toBe(TOKEN);
    expect(spec.options.env?.CLAUDE_EMOTE_SESSION_LABEL).toBe("gp2");
    // Regression: windowsHide also hides Neutralino's GUI window even though
    // the process and taskbar icon remain alive.
    expect(spec.options.windowsHide).toBe(false);
  });

  it("replaces untrusted parent label settings with the resolved value", () => {
    const command = {
      executable: process.execPath,
      args: ["fake-overlay.js"],
      cwd: "C:\\tmp",
      kind: "override" as const,
    };
    const spec = buildDesktopOverlaySpawnSpec(
      command,
      {
        CLAUDE_EMOTE_SESSION_LABEL: "D:\\private\\full\\path",
        CLAUDE_EMOTE_HIDE_SESSION_LABEL: "1",
      },
      "http://127.0.0.1:3210/event",
      TOKEN,
      "safe-project",
    );
    expect(spec.options.env?.CLAUDE_EMOTE_SESSION_LABEL).toBe("safe-project");
    expect(spec.options.env?.CLAUDE_EMOTE_HIDE_SESSION_LABEL).toBeUndefined();
    expect(JSON.stringify(spec.options.env)).not.toContain(
      "D:\\\\private\\\\full\\\\path",
    );
  });

  it("passes only an explicit hide marker when identity is disabled", () => {
    const command = {
      executable: process.execPath,
      args: [],
      cwd: "C:\\tmp",
      kind: "override" as const,
    };
    const spec = buildDesktopOverlaySpawnSpec(
      command,
      {},
      "http://127.0.0.1:3210/event",
      TOKEN,
      null,
    );
    expect(spec.options.env?.CLAUDE_EMOTE_SESSION_LABEL).toBeUndefined();
    expect(spec.options.env?.CLAUDE_EMOTE_HIDE_SESSION_LABEL).toBe("1");
  });
});
