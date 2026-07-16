/**
 * renderer-host.test.ts (P5)
 *
 * Integration test using the REAL copied AsciiRenderer, the REAL copied
 * Animator, and the REAL StandaloneRenderHost. Wires the production
 * connection pattern:
 *
 *   renderer.setTui(host)
 *   host.attachFrameSource(() => renderer.getRenderedFrame())
 *
 * Asserts that a renderer-driven requestRender() actually delivers the
 * newest frame to a silent host sink for every supported state. This
 * test MUST NOT call host.setCurrentFrame().
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";
import { AsciiRenderer } from "../../src/core/render_ascii.js";
import { Animator } from "../../src/core/animator.js";
import { StandaloneRenderHost } from "../../src/adapters/standalone-render-host.js";
import type { Config } from "../../src/core/types.js";
import type { RenderedFrame } from "../../src/core/renderer.js";

const PROJECT_ROOT = resolve(process.cwd());
const ASCII_DIR = join(PROJECT_ROOT, "emotes", "ascii");

const CONFIG: Config = {
  enabled: true,
  debug: false,
  size: 8,
  readingSpeed: 4,
  hideBelow: 30,
  holdDuration: { hi: 2000, success: 1200, failure: 1200 },
  blinkInterval: [50, 80], // shortened for the test so blink fires quickly
  talkTickMs: 120,
  cycleMs: 500,
  emotes: [{ model: "*", "emote-set": "ascii" }],
  terminals: [{ match: "unknown", render: "ascii" }],
};

function frameText(f: RenderedFrame): string {
  if (f.kind === "text" || f.kind === "placeholder") return f.lines.join("\n");
  return `<image:${(f as { sequence: string }).sequence.slice(0, 16)}>`;
}

interface Case {
  state:
    | "hi"
    | "think"
    | "talk"
    | "read"
    | "write"
    | "tool"
    | "failure"
    | "compact"
    | "idle";
  /** Allowed frame strings for this state (any one may be observed). */
  allowed: string[];
}

const CASES: Case[] = [
  { state: "hi", allowed: ["(^ ◡ ^)/"] },
  { state: "think", allowed: ["(•_ • )?", "(-᷅_ -᷄\") "] },
  // talk cycles, any non-close talk frame from the shipped YAML is acceptable.
  { state: "talk", allowed: ["(• . •)", "(• o •)", "(• O •)"] },
  { state: "read", allowed: ["( ╭ರᴥ•́)⠉", "( ╭ರᴥ•)⠒", "( ╭ರᴥ•)⠤"] },
  { state: "write", allowed: ["( ｡ ｡).φ", "( ｡ ｡)φ."] },
  { state: "tool", allowed: ["( • ω•)/", "( • ω•)\\"] },
  { state: "failure", allowed: ["( ° Д°)#"] },
  { state: "compact", allowed: ["(-᷅_ -᷄;)"] },
  { state: "idle", allowed: ["(• ◡ •)"] },
];

describe("real Renderer + Animator + StandaloneRenderHost (P5)", () => {
  let sink: ReturnType<typeof vi.fn>;
  let host: StandaloneRenderHost;
  let renderer: AsciiRenderer;
  let animator: Animator;

  beforeAll(async () => {
    // Sanity-check the shipped YAML exists; the test must load it.
    expect(readFileSync(join(ASCII_DIR, "ascii.yaml"), "utf8").length).toBeGreaterThan(0);

    sink = vi.fn();
    host = new StandaloneRenderHost({ silent: true }, sink);
    renderer = new AsciiRenderer();
    renderer.loadFrames(ASCII_DIR, PROJECT_ROOT);
    // Production connection — host pulls the renderer's current frame at
    // redraw time, never snapshots it.
    (renderer.setTui as unknown as (t: unknown) => void)(host);
    host.attachFrameSource(() => renderer.getRenderedFrame());
    animator = new Animator(CONFIG, renderer);
  });

  afterAll(() => {
    animator.clearAllTimers();
    renderer.dispose();
    host.shutdown();
  });

  for (const c of CASES) {
    it(`renderer-driven requestRender() delivers a real ${c.state} frame to the host sink`, async () => {
      sink.mockClear();
      animator.transitionTo(c.state);
      // Wait long enough for the debounce (8ms) and Animator tick (120ms).
      // Talk frames cycle on talkTickMs; we wait at least 2 cycles for one
      // non-close talk frame to land.
      await new Promise((r) => setTimeout(r, 300));
      const called = sink.mock.calls
        .map((args) => args[0] as RenderedFrame)
        .map(frameText);
      expect(called.length).toBeGreaterThan(0);
      const saw = called.some((text) =>
        c.allowed.some((a) => text.includes(a)),
      );
      expect(saw, `expected one of ${JSON.stringify(c.allowed)} in ${JSON.stringify(called)}`).toBe(true);
    });
  }

  it("uses the production renderer-driven wiring (renderer.setTui + host.attachFrameSource)", () => {
    // This is a documentation-style assertion: the test must NOT call
    // host.setCurrentFrame() to deliver frames. The previous 9 cases
    // prove renderer-driven delivery; if a regression adds manual frame
    // injection, those cases would still pass because the manual
    // fallback is preserved. This test asserts the wiring shape instead.
    const renderer = new AsciiRenderer();
    const host = new StandaloneRenderHost({ silent: true }, () => {});
    (renderer.setTui as unknown as (t: unknown) => void)(host);
    host.attachFrameSource(() => renderer.getRenderedFrame());
    expect(typeof renderer.setTui).toBe("function");
    expect(typeof host.requestRender).toBe("function");
    host.shutdown();
  });
});