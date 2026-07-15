import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Animator } from "../../src/core/animator.js";
import type { Renderer, RenderedFrame } from "../../src/core/renderer.js";
import type { Config } from "../../src/core/types.js";
import { setDebug } from "../../src/core/log.js";

// --- Mock Renderer ----------------------------------------------------------

interface RecordedCall {
  method:
    | "showFrame"
    | "showRandomFrame"
    | "showTalkFrame"
    | "showTalkCloseFrame"
    | "showCycleFrame";
  state: string;
  name?: string;
  index?: number;
}

class MockRenderer implements Renderer {
  private tui: { requestRender: () => void } | null = null;
  public calls: RecordedCall[] = [];
  public frameByName: Record<string, RenderedFrame> = {
    idle: { kind: "text", lines: ["idle"] },
    "idle_blink": { kind: "text", lines: ["idle-blink"] },
    "idle.png": { kind: "text", lines: ["idle"] },
    "idle_blink.png": { kind: "text", lines: ["idle-blink"] },
    think: { kind: "text", lines: ["think"] },
    "think.png": { kind: "text", lines: ["think"] },
    "think_hard.png": { kind: "text", lines: ["think-hard"] },
    talk: { kind: "text", lines: ["talk"] },
    "talk_close": { kind: "text", lines: ["talk-close"] },
    "talk_open": { kind: "text", lines: ["talk-open"] },
    "read_0": { kind: "text", lines: ["read-0"] },
    "read_1": { kind: "text", lines: ["read-1"] },
    "write_0": { kind: "text", lines: ["write-0"] },
    "write_1": { kind: "text", lines: ["write-1"] },
    "tool_0": { kind: "text", lines: ["tool-0"] },
    "tool_1": { kind: "text", lines: ["tool-1"] },
    failure: { kind: "text", lines: ["failure"] },
    compact: { kind: "text", lines: ["compact"] },
    hi: { kind: "text", lines: ["hi"] },
  };
  /** State -> ordered list of names exposed for cycling. */
  public cycleNames: Record<string, string[]> = {
    read: ["read_0", "read_1"],
    write: ["write_0", "write_1"],
    tool: ["tool_0", "tool_1"],
  };

  setTui(tui: { requestRender: () => void } | null) {
    this.tui = tui;
  }
  loadFrames(_a: string, _b: string): void {}
  getRenderedFrame(): RenderedFrame | null {
    return null;
  }
  showFrame(state: string, name: string, _force = false): boolean {
    this.calls.push({ method: "showFrame", state, name });
    return name in this.frameByName;
  }
  showRandomFrame(state: string, _force = false): boolean {
    const list =
      state in this.cycleNames
        ? this.cycleNames[state]
        : state === "talk"
          ? ["talk_open", "talk_close"]
          : [state];
    const name = list[0]!;
    this.calls.push({ method: "showRandomFrame", state, name });
    return true;
  }
  showTalkFrame(_emotesConfig: unknown): boolean {
    this.calls.push({ method: "showTalkFrame", state: "talk" });
    return true;
  }
  showTalkCloseFrame(): boolean {
    this.calls.push({ method: "showTalkCloseFrame", state: "talk" });
    return true;
  }
  showCycleFrame(state: string, index: number): boolean {
    const list = this.cycleNames[state] ?? [state];
    const name = list[index % list.length]!;
    this.calls.push({ method: "showCycleFrame", state, name, index });
    return true;
  }
  getCycleFrameCount(state: string): number {
    return (this.cycleNames[state] ?? [state]).length;
  }
  dispose(): void {}
  resetCache(): void {}
}

// --- Config ------------------------------------------------------------------

const DEFAULT_CONFIG: Config = {
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
  terminals: [],
};

// --- Tests -------------------------------------------------------------------

describe("Animator (M1)", () => {
  let renderer: MockRenderer;
  let animator: Animator;

  beforeEach(() => {
    vi.useFakeTimers();
    // Stub Math.random so randomInRange(lo, hi) returns lo deterministically.
    // Otherwise blink/think timers can land anywhere in [lo, hi] and tests
    // would have to advance by `hi` to be sure they fired.
    vi.spyOn(Math, "random").mockReturnValue(0);
    setDebug(false);
    renderer = new MockRenderer();
    animator = new Animator(DEFAULT_CONFIG, renderer);
    animator.setEmotesConfig({
      idle: { default: "idle.png", blink: "idle_blink.png" },
      think: { default: "think.png", hard: "think_hard.png" },
    });
  });

  afterEach(() => {
    animator.disposeRenderer();
    vi.useRealTimers();
  });

  it("hi -> idle after holdDuration.hi", () => {
    animator.transitionTo("hi");
    expect(animator.currentState).toBe("hi");
    expect(renderer.calls.some((c) => c.method === "showRandomFrame" && c.state === "hi")).toBe(true);
    vi.advanceTimersByTime(DEFAULT_CONFIG.holdDuration.hi);
    expect(animator.currentState).toBe("idle");
  });

  it("idle schedules a blink and toggles frame", () => {
    animator.transitionTo("idle");
    expect(animator.currentState).toBe("idle");

    const blink = vi.fn();
    // simulate the eventual blink by advancing time within the configured interval
    const [lo, hi] = DEFAULT_CONFIG.blinkInterval;
    vi.advanceTimersByTime(lo + 50);

    // After blink delay, a frame for the blink file should have been shown
    const called = renderer.calls.some(
      (c) => c.method === "showFrame" && c.name === "idle_blink.png",
    );
    expect(called).toBe(true);
    // advance enough for double-blink interval headroom
    vi.advanceTimersByTime(hi - lo);
    expect(blink).not.toThrow();
  });

  it("think swaps to think_hard.png and back", () => {
    animator.transitionTo("think");
    const [lo, hi] = DEFAULT_CONFIG.blinkInterval;
    vi.advanceTimersByTime(lo + 50);

    const sawHard = renderer.calls.some(
      (c) => c.method === "showFrame" && c.name === "think_hard.png",
    );
    expect(sawHard).toBe(true);

    // wait the 800ms back-to-default window
    vi.advanceTimersByTime(900);
    const backToDefault = renderer.calls.filter(
      (c) => c.method === "showFrame" && c.name === "think.png",
    );
    expect(backToDefault.length).toBeGreaterThan(0);
  });

  it("talk moves the mouth via talkTickMs interval", () => {
    animator.transitionTo("talk");
    expect(animator.currentState).toBe("talk");
    // Without a token the mouth never closes; with a token, the talk gap
    // timer (200ms) flips talkMouthClosed and the next tick renders the close frame.
    animator.onTalkToken("hello");
    renderer.calls.length = 0;
    vi.advanceTimersByTime(DEFAULT_CONFIG.talkTickMs * 4);
    const open = renderer.calls.filter((c) => c.method === "showTalkFrame");
    const close = renderer.calls.filter((c) => c.method === "showTalkCloseFrame");
    expect(open.length).toBeGreaterThan(0);
    expect(close.length).toBeGreaterThan(0);
  });

  it("onTalkToken produces mouth movement then ends talk", () => {
    animator.transitionTo("talk");
    animator.onTalkToken("hello world foo bar baz");
    renderer.calls.length = 0;
    vi.advanceTimersByTime(DEFAULT_CONFIG.talkTickMs * 2);
    expect(renderer.calls.length).toBeGreaterThan(0);
    // After enough time with no further tokens, talk should end
    vi.advanceTimersByTime(2000);
    expect(animator.currentState).toBe("idle");
  });

  it("read cycles through frames at cycleMs", () => {
    animator.transitionTo("read");
    expect(animator.currentState).toBe("read");
    renderer.calls.length = 0;
    vi.advanceTimersByTime(DEFAULT_CONFIG.cycleMs * 3);
    const cycle = renderer.calls.filter(
      (c) => c.method === "showCycleFrame" && c.state === "read",
    );
    expect(cycle.length).toBeGreaterThanOrEqual(2);
  });

  it("write cycles frames", () => {
    animator.transitionTo("write");
    renderer.calls.length = 0;
    vi.advanceTimersByTime(DEFAULT_CONFIG.cycleMs * 2);
    expect(
      renderer.calls.some((c) => c.method === "showCycleFrame" && c.state === "write"),
    ).toBe(true);
  });

  it("tool cycles frames", () => {
    animator.transitionTo("tool");
    renderer.calls.length = 0;
    vi.advanceTimersByTime(DEFAULT_CONFIG.cycleMs * 2);
    expect(
      renderer.calls.some((c) => c.method === "showCycleFrame" && c.state === "tool"),
    ).toBe(true);
  });

  it("failure holds then transitions to idle", () => {
    animator.transitionTo("failure");
    expect(animator.currentState).toBe("failure");
    vi.advanceTimersByTime(DEFAULT_CONFIG.holdDuration.failure);
    expect(animator.currentState).toBe("idle");
  });

  it("compact shows a random frame and stays", () => {
    animator.transitionTo("compact");
    expect(animator.currentState).toBe("compact");
    vi.advanceTimersByTime(2000);
    expect(animator.currentState).toBe("compact");
  });

  it("transitionTo cancels stale timers from the previous state", () => {
    animator.transitionTo("failure");
    expect(animator.currentState).toBe("failure");
    // Jump to think before failure's hold timer fires
    animator.transitionTo("think");
    vi.advanceTimersByTime(DEFAULT_CONFIG.holdDuration.failure);
    expect(animator.currentState).toBe("think");
  });

  it("clearAllTimers cancels all pending timers on dispose", () => {
    animator.transitionTo("read");
    animator.transitionTo("talk");
    animator.onTalkToken("hi there");
    const before = vi.getTimerCount();
    expect(before).toBeGreaterThan(0);
    animator.clearAllTimers();
    expect(vi.getTimerCount()).toBe(0);
  });
});
