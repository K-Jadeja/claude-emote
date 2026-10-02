/**
 * focus-windows-terminal.test.ts
 *
 * Unit tests for the WT-window focus resolver. The resolver only
 * performs I/O through an injectable `execImpl`; tests never call a
 * real `wt.exe`.
 *
 * The launcher passes the user's `WT_SESSION` (the WT window GUID)
 * into the host as `CLAUDE_EMOTE_WT_WINDOW_ID`. The focuser uses it
 * as the `-w <id>` arg to `wt.exe focus-tab --target 0`.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createWindowsTerminalFocus,
  type ExecFileFn,
  type WindowsTerminalFocusOptions,
} from "../../src/host/focus-windows-terminal.js";

const WT = "C:\\Windows\\System32\\wt.exe";
const WINDOW_ID = "3a9e3981-828c-4145-83d8-eea2c0846260";

function makeOptions(
  overrides: Partial<WindowsTerminalFocusOptions> & {
    execImpl: ExecFileFn;
  },
): WindowsTerminalFocusOptions {
  return {
    wtExecutable: WT,
    wtWindowId: WINDOW_ID,
    platform: "win32",
    diagnostics: () => {},
    ...overrides,
  };
}

describe("createWindowsTerminalFocus", () => {
  it("is a permanent no-op on non-win32 platforms", async () => {
    const execImpl = vi.fn<ExecFileFn>();
    const focuser = createWindowsTerminalFocus(
      makeOptions({ execImpl, platform: "linux" }),
    );
    const outcome = await focuser.focus();
    expect(outcome).toEqual({ kind: "best-effort-noop", reason: "not-windows" });
    expect(execImpl).not.toHaveBeenCalled();
  });

  it("is a permanent no-op when wtExecutable is null", async () => {
    const execImpl = vi.fn<ExecFileFn>();
    const focuser = createWindowsTerminalFocus(
      makeOptions({ execImpl, wtExecutable: null }),
    );
    const outcome = await focuser.focus();
    expect(outcome).toEqual({ kind: "best-effort-noop", reason: "wt-not-found" });
    expect(execImpl).not.toHaveBeenCalled();
  });

  it("is a permanent no-op when wtExecutable is an empty string", async () => {
    const execImpl = vi.fn<ExecFileFn>();
    const focuser = createWindowsTerminalFocus(
      makeOptions({ execImpl, wtExecutable: "" }),
    );
    const outcome = await focuser.focus();
    expect(outcome).toEqual({ kind: "best-effort-noop", reason: "wt-not-found" });
    expect(execImpl).not.toHaveBeenCalled();
  });

  it("is a permanent no-op when wtWindowId is null (defensive: never call wt.exe with empty id)", async () => {
    const execImpl = vi.fn<ExecFileFn>();
    const focuser = createWindowsTerminalFocus(
      makeOptions({ execImpl, wtWindowId: null }),
    );
    const outcome = await focuser.focus();
    expect(outcome).toEqual({
      kind: "best-effort-noop",
      reason: "not-in-windows-terminal",
    });
    expect(execImpl).not.toHaveBeenCalled();
  });

  it("is a permanent no-op when wtWindowId is an empty string", async () => {
    const execImpl = vi.fn<ExecFileFn>();
    const focuser = createWindowsTerminalFocus(
      makeOptions({ execImpl, wtWindowId: "" }),
    );
    const outcome = await focuser.focus();
    expect(outcome).toEqual({
      kind: "best-effort-noop",
      reason: "not-in-windows-terminal",
    });
    expect(execImpl).not.toHaveBeenCalled();
  });

  it("issues `focus-tab --target 0 -w <windowId>` and resolves focused on success", async () => {
    const execImpl = vi.fn<ExecFileFn>(async (file, args) => {
      expect(file).toBe(WT);
      expect(args).toEqual(["focus-tab", "--target", "0", "-w", WINDOW_ID]);
      return { stdout: "", stderr: "" };
    });
    const focuser = createWindowsTerminalFocus(makeOptions({ execImpl }));
    const outcome = await focuser.focus();
    expect(outcome).toEqual({
      kind: "focused",
      windowId: WINDOW_ID,
      tabIndex: 0,
    });
    expect(execImpl).toHaveBeenCalledTimes(1);
  });

  it("returns best-effort-noop with reason when focus-tab exits non-zero", async () => {
    const execImpl = vi.fn<ExecFileFn>(async () => {
      const err = new Error("fake non-zero exit") as Error & { code?: number };
      err.code = 1;
      throw err;
    });
    const focuser = createWindowsTerminalFocus(makeOptions({ execImpl }));
    const outcome = await focuser.focus();
    expect(outcome.kind).toBe("best-effort-noop");
    if (outcome.kind === "best-effort-noop") {
      expect(outcome.reason).toContain("exit 1");
    }
  });

  it("dedupes concurrent focus() calls into a single execImpl call", async () => {
    let resolveExec: (value: { stdout: string; stderr: string }) => void =
      () => {};
    const execImpl = vi.fn<ExecFileFn>(
      () =>
        new Promise((resolve) => {
          resolveExec = resolve;
        }),
    );
    const focuser = createWindowsTerminalFocus(makeOptions({ execImpl }));

    const p1 = focuser.focus();
    const p2 = focuser.focus();
    expect(execImpl).toHaveBeenCalledTimes(1);

    resolveExec({ stdout: "", stderr: "" });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.kind).toBe("focused");
    expect(r2.kind).toBe("focused");
    expect(execImpl).toHaveBeenCalledTimes(1);
  });

  it("accepts the exact window GUID passed by the launcher (no probing)", async () => {
    const execImpl = vi.fn<ExecFileFn>(async () => ({ stdout: "", stderr: "" }));
    const focuser = createWindowsTerminalFocus(
      makeOptions({
        execImpl,
        wtWindowId: "11111111-2222-3333-4444-555555555555",
      }),
    );
    await focuser.focus();
    expect(execImpl).toHaveBeenCalledWith(
      WT,
      [
        "focus-tab",
        "--target",
        "0",
        "-w",
        "11111111-2222-3333-4444-555555555555",
      ],
      { timeout: 2000 },
    );
  });
});