/**
 * launcher-windows-terminal-resolver.test.ts
 *
 * Phase 10 / Defect A: deterministic tests for the WT executable
 * resolver. These cover the AppX alias case (`existsSync` returns
 * false because of the AppX-managed target, `lstatSync` reports a
 * symlink) and the `where.exe` invocation contract.
 *
 * The tests never call out to `where.exe` on a real machine: a
 * fake `execImpl` is injected.
 */

import { describe, it, expect } from "vitest";
import {
  parseWhereExecutableOutput,
  probeWindowsAppsAlias,
  findWindowsTerminalExecutable,
  type FsProbe,
  type ExecProbe,
} from "../../src/launcher/args.js";

function makeFs(opts?: {
  existPaths?: Set<string>;
  symlinkPaths?: Set<string>;
}): FsProbe {
  const exist = opts?.existPaths ?? new Set<string>();
  const sym = opts?.symlinkPaths ?? new Set<string>();
  return {
    existsSync: (p) => exist.has(p),
    lstatSync: (p) => (sym.has(p) ? { isSymbolicLink: () => true } : null),
  };
}

function makeExec(stdoutByArgs: Record<string, string> = {}): ExecProbe & {
  calls: Array<{ file: string; args: string[]; opts: object }>;
} {
  const calls: Array<{ file: string; args: string[]; opts: object }> = [];
  return {
    calls,
    execFileSync(file, args, opts) {
      calls.push({ file, args, opts });
      const key = `${file} ${args.join(" ")}`;
      if (!(key in stdoutByArgs)) {
        const err = new Error("not found") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return stdoutByArgs[key]!;
    },
  };
}

// LOCALAPPDATA values used by tests:
//   - The "WindowsApps" alias is at <LOCALAPPDATA>\\Microsoft\\WindowsApps\\wt.exe.
//   - Tests that exercise the canonical-alias probe pass
//     "C:\\Users\\K\\AppData\\Local".
//   - Tests that need to bypass the canonical alias (so the resolver
//     falls through to where.exe or PATH) pass "C:\\NoSuchUser".
const VALID_LOCALAPPDATA = "C:\\Users\\K\\AppData\\Local";
const MISSING_LOCALAPPDATA = "C:\\NoSuchUser";
const ALIAS_PATH = `${VALID_LOCALAPPDATA}\\Microsoft\\WindowsApps\\wt.exe`;

describe("parseWhereExecutableOutput", () => {
  it("returns an empty array for empty or non-string input", () => {
    expect(parseWhereExecutableOutput("")).toEqual([]);
    expect(parseWhereExecutableOutput(undefined)).toEqual([]);
    expect(parseWhereExecutableOutput(null)).toEqual([]);
  });

  it("splits LF output and trims each line", () => {
    const out = parseWhereExecutableOutput(
      "C:\\A\\wt.exe\nC:\\B\\wt.exe\n",
    );
    expect(out).toEqual(["C:\\A\\wt.exe", "C:\\B\\wt.exe"]);
  });

  it("splits CRLF output (the where.exe default on Windows)", () => {
    const out = parseWhereExecutableOutput(
      "C:\\A\\wt.exe\r\nC:\\B\\wt.exe\r\n",
    );
    expect(out).toEqual(["C:\\A\\wt.exe", "C:\\B\\wt.exe"]);
  });

  it("drops blank lines and trims surrounding whitespace", () => {
    const out = parseWhereExecutableOutput(
      "  C:\\A\\wt.exe  \r\n\r\n   \r\nC:\\B\\wt.exe\r\n",
    );
    expect(out).toEqual(["C:\\A\\wt.exe", "C:\\B\\wt.exe"]);
  });

  it("deduplicates while preserving first occurrence", () => {
    const out = parseWhereExecutableOutput(
      "C:\\A\\wt.exe\r\nC:\\B\\wt.exe\r\nC:\\A\\wt.exe\r\n",
    );
    expect(out).toEqual(["C:\\A\\wt.exe", "C:\\B\\wt.exe"]);
  });
});

describe("probeWindowsAppsAlias", () => {
  it("returns true for an existsSync-confirmed file", () => {
    const fs = makeFs({ existPaths: new Set([ALIAS_PATH]) });
    expect(probeWindowsAppsAlias(ALIAS_PATH, fs)).toBe(true);
  });

  it("returns true for a lstat-confirmed symlink even when existsSync is false", () => {
    const fs = makeFs({ symlinkPaths: new Set([ALIAS_PATH]) });
    expect(probeWindowsAppsAlias(ALIAS_PATH, fs)).toBe(true);
  });

  it("returns false for paths that are neither a file nor a symlink", () => {
    const fs = makeFs();
    expect(probeWindowsAppsAlias("C:\\nope\\wt.exe", fs)).toBe(false);
  });

  it("returns false for empty path", () => {
    const fs = makeFs();
    expect(probeWindowsAppsAlias("", fs)).toBe(false);
  });
});

describe("findWindowsTerminalExecutable", () => {
  it("returns null on non-Windows platforms", () => {
    const fs = makeFs({ existPaths: new Set(["/usr/local/bin/wt"]) });
    const exec = makeExec();
    const out = findWindowsTerminalExecutable(
      { PATH: "/usr/local/bin" },
      "linux",
      fs,
      exec,
    );
    expect(out).toBeNull();
    expect(exec.calls).toEqual([]);
  });

  it("uses a nonblank CLAUDE_EMOTE_WT_EXE override when it exists", () => {
    const override = "C:\\fake\\wt.exe";
    const fs = makeFs({ existPaths: new Set([override]) });
    const exec = makeExec();
    const out = findWindowsTerminalExecutable(
      {
        CLAUDE_EMOTE_WT_EXE: override,
        LOCALAPPDATA: VALID_LOCALAPPDATA,
        PATH: "C:\\Windows",
      },
      "win32",
      fs,
      exec,
    );
    expect(out).toBe(override);
    expect(exec.calls).toEqual([]);
  });

  it("ignores a blank CLAUDE_EMOTE_WT_EXE override", () => {
    const fs = makeFs({ existPaths: new Set([ALIAS_PATH]) });
    const exec = makeExec();
    const out = findWindowsTerminalExecutable(
      {
        CLAUDE_EMOTE_WT_EXE: "   ",
        LOCALAPPDATA: VALID_LOCALAPPDATA,
        PATH: "C:\\Windows",
      },
      "win32",
      fs,
      exec,
    );
    expect(out).toBe(ALIAS_PATH);
  });

  it("resolves the canonical WindowsApps alias via lstat when existsSync is false", () => {
    const fs = makeFs({ symlinkPaths: new Set([ALIAS_PATH]) });
    const exec = makeExec();
    const out = findWindowsTerminalExecutable(
      {
        LOCALAPPDATA: VALID_LOCALAPPDATA,
        PATH: "C:\\Windows",
      },
      "win32",
      fs,
      exec,
    );
    expect(out).toBe(ALIAS_PATH);
    // No where.exe call needed when the alias is already launchable.
    expect(exec.calls).toEqual([]);
  });

  it("parses CRLF where.exe output and uses the first launchable entry", () => {
    const found = "C:\\Somewhere\\wt.exe";
    const fs = makeFs({ existPaths: new Set([found]) });
    const exec = makeExec({
      "where.exe wt.exe":
        "C:\\Nonexistent\\wt.exe\r\n" + found + "\r\n",
    });
    const out = findWindowsTerminalExecutable(
      {
        LOCALAPPDATA: MISSING_LOCALAPPDATA,
        PATH: "C:\\Windows",
      },
      "win32",
      fs,
      exec,
    );
    expect(out).toBe(found);
    expect(exec.calls.length).toBe(1);
  });

  it("uses the first valid where.exe result when the first result is invalid", () => {
    const real = "C:\\Real\\wt.exe";
    const fs = makeFs({ existPaths: new Set([real]) });
    const exec = makeExec({
      "where.exe wt.exe": "C:\\Nonexistent\\wt.exe\r\n" + real + "\r\n",
    });
    const out = findWindowsTerminalExecutable(
      {
        LOCALAPPDATA: MISSING_LOCALAPPDATA,
        PATH: "C:\\Windows",
      },
      "win32",
      fs,
      exec,
    );
    expect(out).toBe(real);
  });

  it("handles paths with spaces in where.exe output", () => {
    const spaced = "C:\\Program Files\\WindowsApps\\wt.exe";
    const fs = makeFs({ existPaths: new Set([spaced]) });
    const exec = makeExec({ "where.exe wt.exe": spaced + "\r\n" });
    const out = findWindowsTerminalExecutable(
      {
        LOCALAPPDATA: MISSING_LOCALAPPDATA,
        PATH: "C:\\Windows",
      },
      "win32",
      fs,
      exec,
    );
    expect(out).toBe(spaced);
  });

  it("returns null when no candidate is launchable", () => {
    const fs = makeFs();
    const exec = makeExec();
    const out = findWindowsTerminalExecutable(
      {
        LOCALAPPDATA: MISSING_LOCALAPPDATA,
        PATH: "C:\\Windows",
      },
      "win32",
      fs,
      exec,
    );
    expect(out).toBeNull();
  });

  it("invokes where.exe with the exact production contract (argv, shell:false, windowsHide:true, timeout)", () => {
    const real = "C:\\Real\\wt.exe";
    const fs = makeFs({ existPaths: new Set([real]) });
    const exec = makeExec({ "where.exe wt.exe": real + "\r\n" });
    const out = findWindowsTerminalExecutable(
      {
        LOCALAPPDATA: MISSING_LOCALAPPDATA,
        PATH: "C:\\Windows",
      },
      "win32",
      fs,
      exec,
    );
    expect(out).toBe(real);
    expect(exec.calls).toEqual([
      {
        file: "where.exe",
        args: ["wt.exe"],
        opts: {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          shell: false,
          windowsHide: true,
          timeout: 2_000,
        },
      },
    ]);
  });

  it("uses env-supplied debug logging only when CLAUDE_EMOTE_DEBUG=1", () => {
    // The resolver writes to process.stderr.write only when
    // CLAUDE_EMOTE_DEBUG=1. Capture writes to confirm.
    const originalWrite = process.stderr.write.bind(process.stderr);
    const writes: string[] = [];
    (process.stderr.write as unknown) = (chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };
    try {
      const fs = makeFs();
      const exec = makeExec();
      findWindowsTerminalExecutable(
        {
          LOCALAPPDATA: VALID_LOCALAPPDATA,
          PATH: "C:\\Windows",
          CLAUDE_EMOTE_DEBUG: "1",
        },
        "win32",
        fs,
        exec,
      );
      expect(writes.some((w) => w.includes("[claude-emote]"))).toBe(true);

      writes.length = 0;
      findWindowsTerminalExecutable(
        {
          LOCALAPPDATA: VALID_LOCALAPPDATA,
          PATH: "C:\\Windows",
        },
        "win32",
        fs,
        exec,
      );
      expect(writes).toEqual([]);
    } finally {
      (process.stderr.write as unknown) = originalWrite;
    }
  });
});
