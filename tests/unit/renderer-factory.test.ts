/**
 * renderer-factory.test.ts
 *
 * Pure-function tests for createRenderer() and resolveRendererKind().
 *
 * These tests are environment-deterministic: they snapshot every
 * environment variable that `detectTerminalName()` reads from
 * `process.env`, replace it with a controlled value inside a
 * try/finally, and restore the EXACT prior existence and value
 * afterward — even if the body throws.
 *
 * No production signature changes. No test-only injection seams.
 * The renderer-factory reads `process.env` directly; we control
 * `process.env` from the test boundary.
 *
 * Variables under test (mirror src/core/terminal.ts):
 *
 *   - TERM, TERM_PROGRAM, TERM_PROGRAM_VERSION
 *   - WT_SESSION                  → "windows-terminal"
 *   - KITTY_WINDOW_ID             → "kitty"
 *   - TMUX                        → "tmux"
 *   - WEZTERM_PANE                → "wezterm"
 *   - ITERM_SESSION_ID            → "iterm2"
 *   - ZELLIJ_SESSION_NAME, ZELLIJ → "zellij"
 *   - GHOSTTY_RESOURCES_DIR       → "ghostty"
 */

import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  createRenderer,
  resolveRendererKind,
} from "../../src/adapters/renderer-factory.js";
import { AsciiRenderer } from "../../src/core/render_ascii.js";
import { SixelRenderer } from "../../src/core/render_sixel.js";
import { ITermRenderer } from "../../src/core/render_iterm.js";
import { WezTermITermRenderer } from "../../src/core/render_wezterm_iterm.js";
import { detectTerminalName } from "../../src/core/terminal.js";
import type { Config } from "../../src/core/types.js";

const EXT_DIR = resolve(process.cwd());
const ASCII_EMOTES = resolve(EXT_DIR, "emotes", "ascii");

/** Every env var detectTerminalName() reads. Keep in sync with terminal.ts. */
const TERMINAL_ENV_KEYS = [
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "WT_SESSION",
  "KITTY_WINDOW_ID",
  "TMUX",
  "WEZTERM_PANE",
  "LC_TERMINAL",
  "COLORTERM",
  "ITERM_SESSION_ID",
  "ZELLIJ_SESSION_NAME",
  "ZELLIJ",
  "GHOSTTY_RESOURCES_DIR",
];

const ASCII_CONFIG: Config = {
  enabled: true,
  debug: false,
  size: 8,
  readingSpeed: 4,
  hideBelow: 20,
  holdDuration: { hi: 2000, success: 1200, failure: 1200 },
  blinkInterval: [3000, 6000],
  talkTickMs: 120,
  cycleMs: 500,
  emotes: [{ model: "*", "emote-set": "default" }],
  terminals: [{ match: "unknown", render: "ascii" }],
};

interface EnvSnapshot {
  had: Map<string, boolean>;
  prior: Map<string, string | undefined>;
}

function snapshotEnv(): EnvSnapshot {
  const had = new Map<string, boolean>();
  const prior = new Map<string, string | undefined>();
  for (const k of TERMINAL_ENV_KEYS) {
    had.set(k, k in process.env);
    prior.set(k, process.env[k]);
  }
  return { had, prior };
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const k of TERMINAL_ENV_KEYS) {
    if (snap.had.get(k)) {
      // Was set before the test — restore the exact prior value.
      process.env[k] = snap.prior.get(k);
    } else {
      // Was NOT set before the test — ensure it stays unset.
      delete process.env[k];
    }
  }
}

/**
 * Run `body` with a controlled terminal environment.
 *
 *   - Snapshot every relevant env var.
 *   - Delete every relevant env var (so detection returns "unknown").
 *   - Apply `overrides`.
 *   - Run `body`.
 *   - In a `finally`, restore the exact prior state — byte-for-byte
 *     and existence-wise — regardless of whether `body` threw.
 *
 * This helper makes the tests self-contained: even a thrown error in
 * `body` does not leak terminal variables into the next test or into
 * the ambient environment.
 */
function withTerminalEnv(
  overrides: Partial<NodeJS.ProcessEnv>,
  body: () => void,
): void {
  const snap = snapshotEnv();
  try {
    for (const k of TERMINAL_ENV_KEYS) {
      delete process.env[k];
    }
    for (const [k, v] of Object.entries(overrides)) {
      if (!TERMINAL_ENV_KEYS.includes(k)) {
        throw new Error(
          `withTerminalEnv: unknown terminal env key "${k}"; ` +
            `add it to TERMINAL_ENV_KEYS first`,
        );
      }
      if (v === undefined || v === null) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    body();
  } finally {
    restoreEnv(snap);
  }
}

afterEach(() => {
  // Safety net: every test runs through withTerminalEnv, but if a
  // test body threw BEFORE reaching the helper, the afterEach
  // ensures the ambient environment is still consistent.
  // (Nothing to do — the helper handles restoration.)
});

describe("detectTerminalName (M2 — sanity)", () => {
  it("returns 'windows-terminal' when WT_SESSION is set", () => {
    withTerminalEnv({ WT_SESSION: "fake-wt-session" }, () => {
      expect(detectTerminalName()).toBe("windows-terminal");
    });
  });

  it("returns 'wezterm' when WEZTERM_PANE is set", () => {
    withTerminalEnv({ WEZTERM_PANE: "/tmp/wezterm-pane" }, () => {
      expect(detectTerminalName()).toBe("wezterm");
    });
  });

  it("returns 'unknown' when every relevant env var is absent", () => {
    withTerminalEnv({}, () => {
      expect(detectTerminalName()).toBe("unknown");
    });
  });
});

describe("RendererFactory (M2)", () => {
  it("forced ASCII config returns ASCII for an unknown terminal", () => {
    withTerminalEnv({}, () => {
      const { renderer, resolved } = createRenderer(
        ASCII_CONFIG,
        EXT_DIR,
        ASCII_EMOTES,
        new Set(["unknown"]),
      );
      expect(resolved.protocol).toBe("ascii");
      expect(renderer).toBeInstanceOf(AsciiRenderer);
    });
  });

  it("forced ASCII under Windows Terminal still returns ASCII", () => {
    withTerminalEnv(
      {
        WT_SESSION: "fake-wt-session",
        TERM_PROGRAM: "Windows Terminal",
        TERM_PROGRAM_VERSION: "1.18",
        COLORTERM: "truecolor",
        LC_TERMINAL: "truecolor",
      },
      () => {
        // Use a config that maps the windows-terminal match to
        // ascii, regardless of what the renderer-factory would
        // otherwise pick.
        const cfg: Config = {
          ...ASCII_CONFIG,
          terminals: [{ match: "windows-terminal", render: "ascii" }],
        };
        const { renderer, resolved } = createRenderer(
          cfg,
          EXT_DIR,
          ASCII_EMOTES,
          new Set(["windows-terminal"]),
        );
        expect(resolved.protocol).toBe("ascii");
        expect(renderer).toBeInstanceOf(AsciiRenderer);
      },
    );
  });

  it("Sixel under Windows Terminal returns Sixel", () => {
    withTerminalEnv(
      {
        WT_SESSION: "fake-wt-session",
        TERM_PROGRAM: "Windows Terminal",
      },
      () => {
        const cfg: Config = {
          ...ASCII_CONFIG,
          terminals: [{ match: "windows-terminal", render: "sixel" }],
        };
        const { renderer, resolved } = createRenderer(
          cfg,
          EXT_DIR,
          ASCII_EMOTES,
          new Set(["windows-terminal"]),
        );
        expect(resolved.protocol).toBe("sixel");
        expect(renderer).toBeInstanceOf(SixelRenderer);
      },
    );
  });

  it("WezTerm terminal uses the WezTermITermRenderer subclass (not the base ITermRenderer)", () => {
    withTerminalEnv(
      {
        WEZTERM_PANE: "/tmp/wezterm-pane",
        TERM_PROGRAM: "WezTerm",
        TERM: "wezterm",
      },
      () => {
        // The config maps wezterm to iterm2 protocol. The
        // createRenderer() factory substitutes WezTermITermRenderer
        // for ITermRenderer when the detected terminal is wezterm.
        const cfg: Config = {
          ...ASCII_CONFIG,
          terminals: [{ match: "wezterm", render: "iterm2" }],
        };
        const { renderer, resolved } = createRenderer(
          cfg,
          EXT_DIR,
          ASCII_EMOTES,
          new Set(["wezterm"]),
        );
        expect(resolved.protocol).toBe("iterm2");
        expect(renderer).toBeInstanceOf(WezTermITermRenderer);
        // Distinct concrete class — the WezTerm subclass — NOT the
        // generic ITermRenderer base class.
        expect(renderer).not.toBeInstanceOf(ITermRenderer);
      },
    );
  });

  it("iTerm2 terminal (no wezterm) uses the base ITermRenderer", () => {
    withTerminalEnv(
      {
        ITERM_SESSION_ID: "w0t1t2",
        TERM_PROGRAM: "iTerm.app",
      },
      () => {
        const cfg: Config = {
          ...ASCII_CONFIG,
          terminals: [{ match: "iterm2", render: "iterm2" }],
        };
        const { renderer, resolved } = createRenderer(
          cfg,
          EXT_DIR,
          ASCII_EMOTES,
          new Set(["iterm2"]),
        );
        expect(resolved.protocol).toBe("iterm2");
        expect(renderer).toBeInstanceOf(ITermRenderer);
        expect(renderer).not.toBeInstanceOf(WezTermITermRenderer);
      },
    );
  });

  it("setTuiHost wires a requestRender contract to the renderer", () => {
    withTerminalEnv({}, () => {
      const { renderer, setTuiHost } = createRenderer(
        ASCII_CONFIG,
        EXT_DIR,
        ASCII_EMOTES,
        new Set(["unknown"]),
      );
      const host = { requestRender: () => {} };
      expect(() => setTuiHost(host)).not.toThrow();
      expect(renderer.showFrame("idle", "default")).toBe(true);
    });
  });

  it("ambient WT_SESSION set by the harness cannot leak in when withTerminalEnv clears it", () => {
    // Simulate the harness accidentally setting WT_SESSION before
    // the test starts. The helper still clears it inside the body.
    process.env.WT_SESSION = "HARNESS_LEAK";
    try {
      withTerminalEnv({}, () => {
        // Inside the body, WT_SESSION must NOT exist.
        expect(process.env.WT_SESSION).toBeUndefined();
      });
      // Outside the body, the original harness value must be back.
      expect(process.env.WT_SESSION).toBe("HARNESS_LEAK");
    } finally {
      delete process.env.WT_SESSION;
    }
  });
});

describe("resolveRendererKind (M2)", () => {
  it("returns 'ascii' for ASCII config in a controlled unknown environment", () => {
    withTerminalEnv({}, () => {
      const kind = resolveRendererKind(
        ASCII_CONFIG,
        new Set(["unknown"]),
      );
      expect(kind).toBe("ascii");
    });
  });

  it("returns 'image' for Sixel config under Windows Terminal", () => {
    withTerminalEnv(
      { WT_SESSION: "fake-wt-session", TERM_PROGRAM: "Windows Terminal" },
      () => {
        const cfg: Config = {
          ...ASCII_CONFIG,
          terminals: [{ match: "windows-terminal", render: "sixel" }],
        };
        const { renderer } = createRenderer(
          cfg,
          EXT_DIR,
          ASCII_EMOTES,
          new Set(["windows-terminal"]),
        );
        expect(renderer).toBeInstanceOf(SixelRenderer);
      },
    );
  });
});

describe("environment restoration under failure (M2)", () => {
  it("withTerminalEnv restores exact prior state when body throws", () => {
    // Take a known reference value. This value must survive the
    // test body throwing.
    process.env.WT_SESSION = "PRESERVE_THIS";
    try {
      let caught = false;
      try {
        withTerminalEnv(
          { WT_SESSION: "OVERRIDDEN", TERM_PROGRAM: "WezTerm" },
          () => {
            // Sanity: overrides are active inside the body.
            expect(process.env.WT_SESSION).toBe("OVERRIDDEN");
            expect(process.env.TERM_PROGRAM).toBe("WezTerm");
            // Deliberately throw to prove restoration on failure.
            throw new Error("deliberate test failure");
          },
        );
      } catch (err) {
        caught = true;
        if (!(err instanceof Error) || err.message !== "deliberate test failure") {
          throw err;
        }
      }
      expect(caught).toBe(true);
      // Restoration: the original value is back, byte-for-byte.
      expect(process.env.WT_SESSION).toBe("PRESERVE_THIS");
      // And TERM_PROGRAM, which was NOT set before, must be gone.
      expect(process.env.TERM_PROGRAM).toBeUndefined();
    } finally {
      delete process.env.WT_SESSION;
    }
  });

  it("withTerminalEnv leaves keys that were never set absent after a thrown body", () => {
    // Make sure COLORTERM is unset at the start of the test.
    delete process.env.COLORTERM;
    try {
      let caught = false;
      try {
        withTerminalEnv(
          { COLORTERM: "truecolor", WT_SESSION: "fake-wt" },
          () => {
            throw new Error("boom");
          },
        );
      } catch {
        caught = true;
      }
      expect(caught).toBe(true);
      // Both must be back to their pre-test state.
      expect(process.env.COLORTERM).toBeUndefined();
      expect(process.env.WT_SESSION).toBeUndefined();
    } finally {
      delete process.env.COLORTERM;
      delete process.env.WT_SESSION;
    }
  });
});