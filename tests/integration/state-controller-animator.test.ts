/**
 * state-controller-animator.test.ts (P7)
 *
 * Integration tests using the REAL copied Animator + REAL copied
 * AsciiRenderer + REAL StandaloneRenderHost + bundled ASCII set.
 * The new state controller drives the Animator.
 *
 * Uses real timers (not fake timers) because the Animator's
 * setTimeout chain needs a working event loop. The holdDuration
 * values in the Config are kept short (60ms / 80ms) so the suites
 * finish quickly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolve, join } from "node:path";
import { AsciiRenderer } from "../../src/core/render_ascii.js";
import { Animator } from "../../src/core/animator.js";
import { StandaloneRenderHost } from "../../src/adapters/standalone-render-host.js";
import { createAvatarStateController } from "../../src/host/avatar-state-controller.js";
import type { Config } from "../../src/core/types.js";
import type { RenderedFrame } from "../../src/core/renderer.js";

const PROJECT_ROOT = resolve(process.cwd());
const ASCII_DIR = join(PROJECT_ROOT, "emotes", "ascii");

const FAILURE_FRAME = "( ° Д°)#";
const COMPACT_FRAME = "(-᷅_ -᷄;)";
const THINK_FRAME = "(•_ • )?";
const IDLE_FRAME = "(• ◡ •)";

const CONFIG: Config = {
  enabled: true,
  debug: false,
  size: 8,
  readingSpeed: 4,
  hideBelow: 30,
  holdDuration: { hi: 30, success: 30, failure: 80 },
  blinkInterval: [3000, 6000],
  talkTickMs: 120,
  cycleMs: 500,
  emotes: [{ model: "*", "emote-set": "ascii" }],
  terminals: [{ match: "unknown", render: "ascii" }],
};

function frameText(f: RenderedFrame | null): string {
  if (f === null) return "";
  if (f.kind === "text" || f.kind === "placeholder") return f.lines.join("\n");
  return `<image>`;
}

interface Rig {
  sink: ReturnType<typeof vi.fn>;
  host: StandaloneRenderHost;
  renderer: AsciiRenderer;
  animator: Animator;
  controller: ReturnType<typeof createAvatarStateController>;
}

async function setupRig(): Promise<Rig> {
  const sink = vi.fn();
  const host = new StandaloneRenderHost({ silent: true }, sink);
  const renderer = new AsciiRenderer();
  renderer.loadFrames(ASCII_DIR, PROJECT_ROOT);
  (renderer.setTui as unknown as (t: unknown) => void)(host);
  host.attachFrameSource(() => renderer.getRenderedFrame());
  const animator = new Animator(CONFIG, renderer);
  // Establish the initial visible state (idle) before the controller
  // receives events. The startup transition is the single exception
  // that may call animator.transitionTo directly.
  animator.transitionTo("idle");
  // Wait one tick so the initial frame has been resolved.
  await new Promise((r) => setTimeout(r, 30));
  const controller = createAvatarStateController({
    animator: {
      transitionTo: (s) => animator.transitionTo(s),
      onTalkToken: (t) => animator.onTalkToken(t),
      setHoldNextState: (s) => animator.setHoldNextState(s),
    },
    onShutdown: () => {},
  });
  return { sink, host, renderer, animator, controller };
}

function teardownRig(rig: Rig) {
  rig.controller.shutdown();
  rig.animator.clearAllTimers();
  rig.renderer.dispose();
  rig.host.shutdown();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("real Animator + state controller (P7)", () => {
  let rig: Rig;

  beforeEach(async () => {
    rig = await setupRig();
  });
  afterEach(() => {
    teardownRig(rig);
  });

  function lastSinkFrameText(): string {
    const calls = rig.sink.mock.calls;
    if (calls.length === 0) return "";
    return frameText(calls[calls.length - 1]![0]);
  }

  it("Failure hold: failure frame appears and lower-priority states cannot replace it", async () => {
    rig.controller.handle({ state: "failure" });
    await sleep(30);
    expect(lastSinkFrameText()).toContain(FAILURE_FRAME);
    // Try to crowd the failure with ordinary events.
    rig.controller.handle({ state: "think" });
    rig.controller.handle({ state: "read", talkToken: undefined });
    rig.controller.handle({ state: "idle" });
    await sleep(30);
    // Failure frame is still visible.
    expect(lastSinkFrameText()).toContain(FAILURE_FRAME);
    // After the hold, the controller's failure → think transition fires.
    await sleep(120);
    expect(lastSinkFrameText()).toContain(THINK_FRAME);
  });

  it("Compact lock: compact frame appears and stays visible across ordinary events", async () => {
    rig.controller.handle({ state: "compact" });
    await sleep(30);
    expect(lastSinkFrameText()).toContain(COMPACT_FRAME);
    // Try to replace with talk and other ordinary states.
    rig.controller.handle({ state: "talk", talkToken: "x" });
    rig.controller.handle({ state: "think" });
    rig.controller.handle({ state: "read" });
    await sleep(30);
    // Compact remains.
    expect(lastSinkFrameText()).toContain(COMPACT_FRAME);
    // PostCompact → idle release.
    rig.controller.handle({ state: "idle" });
    await sleep(30);
    expect(lastSinkFrameText()).toContain(IDLE_FRAME);
  });

  it("Failure interrupted by compact: compact wins and old failure cannot reappear", async () => {
    rig.controller.handle({ state: "failure" });
    await sleep(30);
    expect(lastSinkFrameText()).toContain(FAILURE_FRAME);
    rig.controller.handle({ state: "compact" });
    await sleep(30);
    expect(lastSinkFrameText()).toContain(COMPACT_FRAME);
    // Wait well past the original failure hold duration.
    await sleep(150);
    expect(lastSinkFrameText()).toContain(COMPACT_FRAME);
    // Release compact.
    rig.controller.handle({ state: "idle" });
    await sleep(30);
    expect(lastSinkFrameText()).toContain(IDLE_FRAME);
  });

  it("Normal turn drives the visible frames end-to-end", async () => {
    rig.controller.handle({ state: "think" });
    await sleep(30);
    expect(lastSinkFrameText()).toContain(THINK_FRAME);
    rig.controller.handle({ state: "read" });
    await sleep(30);
    rig.controller.handle({ state: "think" });
    await sleep(30);
    rig.controller.handle({ state: "talk", talkToken: "hi" });
    await sleep(30);
    rig.controller.handle({ state: "idle" });
    await sleep(30);
    expect(lastSinkFrameText()).toContain(IDLE_FRAME);
  });
});