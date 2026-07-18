/**
 * avatar-process-ascii-fallback.test.ts
 *
 * Phase 10 / Defect B: deterministic tests for the bundled-ASCII
 * renderer fallback. These tests do NOT require a real Chafa binary
 * or a real image renderer: every renderer comes from an injected
 * factory.
 *
 * The unit tests exercise the high-level orchestration function
 * `startRendererRuntimeWithFallback` directly. The production policy
 * (preferred attempt exactly once, ASCII fallback only when selection
 * is automatic, warning emitted exactly once) is tested as a single
 * contract rather than as two manual calls to a lower-level attempt
 * helper.
 */

import { describe, it, expect } from "vitest";
import {
  startRendererRuntimeWithFallback,
  type AsciiRendererFactory,
  type PreferredRendererFactory,
  type RendererStartupDeps,
} from "../../src/host/renderer-startup.js";
import type { Renderer, RenderedFrame } from "../../src/core/renderer.js";
import type { Config } from "../../src/core/types.js";
import { AsciiRenderer } from "../../src/core/render_ascii.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";

class FakeRenderer implements Renderer {
  private frame: RenderedFrame | null = null;
  private disposed = false;
  constructor(initial: RenderedFrame | null = null) {
    this.frame = initial;
  }
  setTui(): void {}
  loadFrames(): void {}
  getRenderedFrame(): RenderedFrame | null {
    return this.frame;
  }
  showFrame(): boolean { return true; }
  showRandomFrame(): boolean { return true; }
  showTalkFrame(): boolean { return true; }
  showTalkCloseFrame(): boolean { return true; }
  showCycleFrame(): boolean { return true; }
  getCycleFrameCount(): number { return 0; }
  dispose(): void { this.disposed = true; }
  resetCache(): void {}
  isDisposed(): boolean { return this.disposed; }
}

function makeConfig(): Config {
  return {
    enabled: true,
    debug: false,
    size: 80,
    readingSpeed: 50,
    hideBelow: 0,
    holdDuration: { hi: 2000, success: 2000, failure: 4000 },
    blinkInterval: [4000, 8000],
    talkTickMs: 120,
    cycleMs: 200,
    emotes: [],
    terminals: [{ match: "unknown", render: "sixel" }],
  };
}

function makeSuccessfulFrame(): RenderedFrame {
  return { kind: "text", lines: ["hello", "world"] };
}

function makeFailingFrame(): RenderedFrame {
  return { kind: "text", lines: [""] };
}

function okValidation(): { ok: boolean; reason?: string } {
  return { ok: true };
}

interface FactorySpies {
  preferred: PreferredRendererFactory & { calls: number; renderers: FakeRenderer[] };
  ascii: AsciiRendererFactory & { calls: number; renderers: FakeRenderer[] };
  warnings: string[];
}

function makeSpies(
  preferredInitial: RenderedFrame,
  asciiInitial: RenderedFrame,
): FactorySpies {
  const preferredRenderers: FakeRenderer[] = [];
  const asciiRenderers: FakeRenderer[] = [];
  let preferredCalls = 0;
  let asciiCalls = 0;
  const preferred: PreferredRendererFactory & {
    calls: number;
    renderers: FakeRenderer[];
  } = Object.assign(
    (
      _config: Config,
      _extDir: string,
      _emoteSetDir: string,
      _user: Set<string>,
    ) => {
      preferredCalls++;
      const r = new FakeRenderer(preferredInitial);
      preferredRenderers.push(r);
      return {
        renderer: r,
        resolved: {
          protocol: "sixel",
          multiplexer: null,
          warning: null,
          warningLevel: "warning",
        },
        setTuiHost: () => {},
      };
    },
    { calls: 0, renderers: preferredRenderers },
  );
  const ascii: AsciiRendererFactory & {
    calls: number;
    renderers: FakeRenderer[];
  } = Object.assign(
    (_emoteSetDir: string, _extDir: string) => {
      asciiCalls++;
      const r = new FakeRenderer(asciiInitial);
      asciiRenderers.push(r);
      return r;
    },
    { calls: 0, renderers: asciiRenderers },
  );
  Object.defineProperty(preferred, "calls", {
    get() { return preferredCalls; },
  });
  Object.defineProperty(ascii, "calls", {
    get() { return asciiCalls; },
  });
  return { preferred, ascii, warnings: [] };
}

function makeDeps(
  spies: FactorySpies,
  asciiInitialOverride?: RenderedFrame,
): RendererStartupDeps {
  return {
    preferredRendererFactory: spies.preferred,
    asciiRendererFactory: spies.ascii,
    waitForInitialFrame: async (getFrame) => {
      const f = getFrame();
      if (f == null) return false;
      if (f.kind === "text") {
        return Array.isArray(f.lines) && f.lines.some((l) => l.length > 0);
      }
      if (f.kind === "image") {
        return typeof f.sequence === "string" && f.sequence.length > 0;
      }
      if (f.kind === "placeholder") {
        return Array.isArray(f.lines) && f.lines.some((l) => l.length > 0);
      }
      return true;
    },
    packageRoot: "/tmp/pkg-root",
    forceResolved: {
      protocol: "ascii",
      multiplexer: null,
      warning: null,
      warningLevel: "warning",
    },
  };
}

const AUTOMATIC_SELECTION = {
  kind: "automatic" as const,
  directory: "/tmp/pkg-root/emotes/default",
};

const ASCII_FALLBACK_DIR = "/tmp/pkg-root/emotes/ascii";

const CUSTOM_SELECTION = {
  kind: "custom" as const,
  directory: "/tmp/custom-emotes",
};

describe("startRendererRuntimeWithFallback (Phase 10 / Defect B)", () => {
  it("preferred renderer succeeds → ASCII factory never called, no warning, preferred runtime returned", async () => {
    const spies = makeSpies(makeSuccessfulFrame(), makeSuccessfulFrame());
    const deps = makeDeps(spies);
    const result = await startRendererRuntimeWithFallback({
      config: makeConfig(),
      selection: AUTOMATIC_SELECTION,
      userConfiguredTerminals: new Set(),
      deps,
      bundledAsciiDirectory: ASCII_FALLBACK_DIR,
      validateEmoteDirectory: okValidation,
      onFallbackWarning: (msg) => spies.warnings.push(msg),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runtime.resolved.protocol).toBe("sixel");
    }
    expect(spies.preferred.calls).toBe(1);
    expect(spies.ascii.calls).toBe(0);
    expect(spies.warnings).toEqual([]);
    expect(spies.preferred.renderers[0]!.isDisposed()).toBe(false);
  });

  it("preferred fails + automatic selection → ASCII factory called once, warning emitted once, ASCII runtime returned, preferred resources disposed", async () => {
    const spies = makeSpies(makeFailingFrame(), makeSuccessfulFrame());
    const deps = makeDeps(spies);
    const result = await startRendererRuntimeWithFallback({
      config: makeConfig(),
      selection: AUTOMATIC_SELECTION,
      userConfiguredTerminals: new Set(),
      deps,
      bundledAsciiDirectory: ASCII_FALLBACK_DIR,
      validateEmoteDirectory: okValidation,
      onFallbackWarning: (msg) => spies.warnings.push(msg),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runtime.resolved.protocol).toBe("ascii");
      expect(result.runtime.selection.directory).toBe(ASCII_FALLBACK_DIR);
    }
    expect(spies.preferred.calls).toBe(1);
    expect(spies.ascii.calls).toBe(1);
    expect(spies.warnings).toHaveLength(1);
    expect(spies.warnings[0]).toMatch(/falling back to bundled ASCII/);
    // Failed preferred resources must be disposed before retry.
    expect(spies.preferred.renderers[0]!.isDisposed()).toBe(true);
  });

  it("preferred AND ASCII both fail → each factory called once, both runtimes disposed, failure returned", async () => {
    const spies = makeSpies(makeFailingFrame(), makeFailingFrame());
    const deps = makeDeps(spies);
    const result = await startRendererRuntimeWithFallback({
      config: makeConfig(),
      selection: AUTOMATIC_SELECTION,
      userConfiguredTerminals: new Set(),
      deps,
      bundledAsciiDirectory: ASCII_FALLBACK_DIR,
      validateEmoteDirectory: okValidation,
      onFallbackWarning: (msg) => spies.warnings.push(msg),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/ascii/);
    }
    expect(spies.preferred.calls).toBe(1);
    expect(spies.ascii.calls).toBe(1);
    // No third attempt is allowed.
    expect(spies.preferred.calls + spies.ascii.calls).toBe(2);
    expect(spies.preferred.renderers[0]!.isDisposed()).toBe(true);
    expect(spies.ascii.renderers[0]!.isDisposed()).toBe(true);
  });

  it("explicit custom selection fails → ASCII factory not called, no warning, original failure returned", async () => {
    const spies = makeSpies(makeFailingFrame(), makeSuccessfulFrame());
    const deps = makeDeps(spies);
    const result = await startRendererRuntimeWithFallback({
      config: makeConfig(),
      selection: CUSTOM_SELECTION,
      userConfiguredTerminals: new Set(),
      deps,
      bundledAsciiDirectory: ASCII_FALLBACK_DIR,
      validateEmoteDirectory: okValidation,
      onFallbackWarning: (msg) => spies.warnings.push(msg),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Reason is the failed preferred attempt — NOT a fallback
      // message.
      expect(result.reason).toMatch(/sixel/);
      expect(result.reason).not.toMatch(/bundled ASCII/i);
    }
    expect(spies.preferred.calls).toBe(1);
    expect(spies.ascii.calls).toBe(0);
    expect(spies.warnings).toEqual([]);
  });

  it("does not mutate the caller's shared config object across either attempt", async () => {
    const spies = makeSpies(makeFailingFrame(), makeSuccessfulFrame());
    const deps = makeDeps(spies);
    const sharedConfig = makeConfig();
    const before = JSON.stringify(sharedConfig);
    const result = await startRendererRuntimeWithFallback({
      config: sharedConfig,
      selection: AUTOMATIC_SELECTION,
      userConfiguredTerminals: new Set(),
      deps,
      bundledAsciiDirectory: ASCII_FALLBACK_DIR,
      validateEmoteDirectory: okValidation,
      onFallbackWarning: (msg) => spies.warnings.push(msg),
    });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(sharedConfig)).toBe(before);
  });
});

describe("AsciiRenderer factory (real renderer wiring)", () => {
  it("the bundled ascii emote directory is present and contains ascii.yaml", () => {
    const pkgRoot = process.cwd();
    const dir = join(pkgRoot, "emotes", "ascii");
    const yaml = join(dir, "ascii.yaml");
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(yaml)).toBe(true);
  });

  it("AsciiRenderer.loadFrames loads the bundled ascii.yaml and reports frames", () => {
    const pkgRoot = process.cwd();
    const dir = join(pkgRoot, "emotes", "ascii");
    const r = new AsciiRenderer();
    r.loadFrames(dir, pkgRoot);
    expect(r.showFrame("idle", "default")).toBe(true);
  });
});

/**
 * Deterministic missing-Chafa subprocess integration.
 *
 * The avatar process auto-selects the bundled ASCII fallback when
 * Chafa is missing AND the emote selection is automatic. This test
 * proves the fallback fires in a real subprocess by removing Chafa
 * from PATH and confirming:
 *
 *   - fallback warning line is printed
 *   - READY line mentions the bundled ascii dir
 *   - /health 200
 *   - bundled think frame appears after a UserPromptSubmit event
 *   - Stop event triggers the idle frame on the same server
 *   - clean child exit (PID no longer alive)
 *
 * It does NOT depend on a host Chafa install.
 */
describe("avatar-process automatic fallback (subprocess, deterministic missing-Chafa)", () => {
  it(
    "image protocol selected, Chafa unavailable → fallback warning + READY + think + idle + clean exit",
    async () => {
      const avatarScript = join(
        process.cwd(),
        "dist",
        "host",
        "avatar-process.js",
      );
      if (!existsSync(avatarScript)) {
        throw new Error(
          `avatar-process.js is not built: ${avatarScript}. Run \`npm run build\` first.`,
        );
      }

      const tmp = join(tmpdir(), "ascii-fallback-" + Date.now());
      mkdirSync(tmp, { recursive: true });
      const cfgDir = join(
        tmp,
        ".claude-emote",
        "extensions",
        "claude-emote",
      );
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(
        join(cfgDir, "config.json"),
        JSON.stringify({
          terminals: [{ match: "unknown", render: "sixel" }],
        }),
        "utf8",
      );

      const restrictedPath = tmp;
      const cleanEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: restrictedPath,
        LOCALAPPDATA: tmp,
        WT_SESSION: "",
        TERM_PROGRAM: "",
        ITERM_SESSION_ID: "",
        KITTY_WINDOW_ID: "",
        WEZTERM_PANE: "",
        GHOSTTY_RESOURCES_DIR: "",
        TMUX: "",
        ZELLIJ_SESSION_NAME: "",
        ZELLIJ: "",
        CLAUDE_EMOTE_CHAFA_PATH: "",
        PI_EMOTE_CHAFA_PATH: "",
        CLAUDE_EMOTE_LOG_FILE: "",
        CLAUDE_EMOTE_DEBUG: "",
        CLAUDE_EMOTE_DEMO_PROTOCOL: "",
      };

      const child = spawn(
        process.execPath,
        [avatarScript, "--port=0", "--instance=fallback-smoke"],
        { env: cleanEnv, stdio: ["ignore", "pipe", "pipe"], cwd: tmp },
      );
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
      child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));

      try {
        const deadline = Date.now() + 8000;
        let readyPort = 0;
        let readyEmoteDir = "";
        while (Date.now() < deadline) {
          if (stdout.includes("CLAUDE_EMOTE_READY")) {
            const allReady = stdout
              .split(/\r?\n/)
              .filter((l) => l.includes("CLAUDE_EMOTE_READY"));
            const readyLine = allReady[allReady.length - 1] ?? "";
            const pm = readyLine.match(/port=(\d+)/);
            const em = readyLine.match(/emoteDir=(\S+)/);
            if (pm) readyPort = Number(pm[1]);
            if (em) readyEmoteDir = em[1];
            break;
          }
          if (child.exitCode !== null) break;
          await new Promise((r) => setTimeout(r, 50));
        }

        const http = await import("node:http");
        const request = (
          path: string,
          method: string,
          body?: string,
        ): Promise<{ code: number; body: string }> =>
          new Promise((res) => {
            const req = http.request(
              {
                host: "127.0.0.1",
                port: readyPort,
                path,
                method,
                headers: body
                  ? {
                      "content-type": "application/json",
                      "content-length": Buffer.byteLength(body),
                    }
                  : undefined,
                timeout: 2000,
              },
              (r) => {
                let buf = "";
                r.setEncoding("utf8");
                r.on("data", (c: string) => (buf += c));
                r.on("end", () =>
                  res({ code: r.statusCode ?? 0, body: buf }),
                );
              },
            );
            req.on("error", () => res({ code: -1, body: "" }));
            req.on("timeout", () => {
              req.destroy();
              res({ code: -1, body: "timeout" });
            });
            if (body) req.write(body);
            req.end();
          });

        const health = readyPort > 0
          ? await request("/health", "GET")
          : { code: -1, body: "" };

        const thinkFrame = "(•_ • )?";
        const thinkEvent = JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "fallback-smoke",
          prompt: "fallback smoke",
        });
        const stdoutBeforeThink = stdout.length;
        const post = readyPort > 0
          ? await request("/event", "POST", thinkEvent)
          : { code: -1, body: "" };

        const thinkDeadline = Date.now() + 4000;
        let thinkSeen = false;
        while (Date.now() < thinkDeadline) {
          if (stdout.slice(stdoutBeforeThink).includes(thinkFrame)) {
            thinkSeen = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }

        const stopEvent = JSON.stringify({
          hook_event_name: "Stop",
          session_id: "fallback-smoke",
        });
        const stdoutBeforeStop = stdout.length;
        const stopPost = readyPort > 0
          ? await request("/event", "POST", stopEvent)
          : { code: -1, body: "" };
        const idleFrame = "(• ◡ •)";
        const stopDeadline = Date.now() + 4000;
        let idleSeen = false;
        while (Date.now() < stopDeadline) {
          if (stdout.slice(stdoutBeforeStop).includes(idleFrame)) {
            idleSeen = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }

        expect(stderr).toMatch(/falling back to bundled ASCII/i);
        expect(readyPort).toBeGreaterThan(0);
        expect(readyEmoteDir).toMatch(/emotes[\\/]ascii$/);
        expect(health.code).toBe(200);
        expect(post.code).toBe(200);
        expect(thinkSeen).toBe(true);
        expect(stopPost.code).toBe(200);
        expect(idleSeen).toBe(true);
      } finally {
        // Cleanup. Order: SIGTERM with bounded wait, then SIGKILL
        // escalation only if needed, then await close. PID check after.
        try { child.kill("SIGTERM"); } catch {}
        await new Promise((res) => {
          const t = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch {}
            res();
          }, 5_000);
          child.once("close", () => { clearTimeout(t); res(); });
        });
        let alive = false;
        try { if (child.pid !== undefined) process.kill(child.pid, 0); alive = true; } catch {}
        try { rmSync(tmp, { recursive: true, force: true }); } catch {}
        expect(alive).toBe(false);
      }
    },
    30_000,
  );
});
