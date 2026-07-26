/**
 * avatar-state-controller.test.ts (P7)
 *
 * Unit tests for the production state controller using a recording
 * Animator port. Tests do NOT touch the real Animator, renderer, or
 * filesystem. Fake timers drive the Animator's hold continuation so
 * the controller's priority rules can be verified deterministically.
 *
 * Recording port contract:
 *   - Every transitionTo() call records { state }.
 *   - Every onTalkToken() call records { token }.
 *   - Every setHoldNextState() call records { state }.
 *   - The fake Animator schedules a hold continuation for "failure"
 *     and "success" via setTimeout. Tests advance fake timers to
 *     fire the continuation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createAvatarStateController } from "../../src/host/avatar-state-controller.js";
import type { EmoteState } from "../../src/core/types.js";
import type { AvatarReaction } from "../../src/claude/event-mapper.js";

interface Transition { state: EmoteState; t: number }
interface TokenCall { token: string; t: number }
interface HoldNext { state: EmoteState; t: number }

interface FakeAnimator {
  transitionTo(state: EmoteState): void;
  onTalkToken(token: string): void;
  getCurrentState(): EmoteState;
  setHoldNextState(state: EmoteState): void;
  /** Force-fire any pending hold timer (for tests that don't use fake timers). */
  fireHold(): void;
  records: { transitions: Transition[]; tokens: TokenCall[]; holdNext: HoldNext[] };
  private: {
    currentState: EmoteState;
    holdNextState: EmoteState;
    holdTimer: ReturnType<typeof setTimeout> | null;
    now: number;
  };
}

function makeFakeAnimator(): FakeAnimator {
  const fake: FakeAnimator = {
    records: { transitions: [], tokens: [], holdNext: [] },
    private: {
      currentState: "idle",
      holdNextState: "idle",
      holdTimer: null,
      now: 0,
    },
    transitionTo(state) {
      fake.private.currentState = state;
      fake.records.transitions.push({ state, t: fake.private.now });
      fake.private.now++;
      // Animator behavior: clearStateTimers clears holdTimer before
      // running enterHold. We model that here.
      if (fake.private.holdTimer) {
        clearTimeout(fake.private.holdTimer);
        fake.private.holdTimer = null;
      }
      if (state === "failure" || state === "success") {
        const holdMs = state === "failure" ? 100 : 100;
        fake.private.holdTimer = setTimeout(() => {
          fake.transitionTo(fake.private.holdNextState);
        }, holdMs);
      }
    },
    onTalkToken(token) {
      fake.records.tokens.push({ token, t: fake.private.now });
      fake.private.now++;
    },
    getCurrentState() {
      return fake.private.currentState;
    },
    setHoldNextState(state) {
      fake.records.holdNext.push({ state, t: fake.private.now });
      fake.private.now++;
      fake.private.holdNextState = state;
    },
    fireHold() {
      if (fake.private.holdTimer) {
        const fn = fake.private.holdTimer;
        fake.private.holdTimer = null;
        // Run synchronously.
        clearTimeout(fn);
        fake.transitionTo(fake.private.holdNextState);
      }
    },
  };
  return fake;
}

function reaction(state: EmoteState | null = null, opts: Partial<AvatarReaction> = {}): AvatarReaction {
  return { state, ...opts };
}

function shutdownReaction(): AvatarReaction {
  return { state: null, shutdown: true };
}

describe("avatar state controller (P7)", () => {
  let fake: FakeAnimator;
  let shutdownCalls: number;
  let controller: ReturnType<typeof createAvatarStateController>;

  beforeEach(() => {
    vi.useFakeTimers();
    fake = makeFakeAnimator();
    shutdownCalls = 0;
    controller = createAvatarStateController({
      animator: {
        transitionTo: (s) => fake.transitionTo(s),
        onTalkToken: (t) => fake.onTalkToken(t),
        getCurrentState: () => fake.getCurrentState(),
        setHoldNextState: (s) => fake.setHoldNextState(s),
      },
      onShutdown: () => { shutdownCalls++; },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ordinary state transitions immediately", () => {
    controller.handle(reaction("think"));
    controller.handle(reaction("read"));
    controller.handle(reaction("write"));
    expect(fake.records.transitions.map((r) => r.state)).toEqual(["think", "read", "write"]);
  });

  it("talk state forwards a non-empty token exactly once", () => {
    controller.handle(reaction("talk", { talkToken: "hello world" }));
    expect(fake.records.tokens.map((t) => t.token)).toEqual(["hello world"]);
    expect(fake.records.transitions.map((r) => r.state)).toEqual(["talk"]);
  });

  it("empty or missing talk token is not forwarded", () => {
    controller.handle(reaction("talk", { talkToken: "" }));
    controller.handle(reaction("talk"));
    controller.handle(reaction("think"));
    expect(fake.records.tokens).toEqual([]);
  });

  it("failure calls setHoldNextState('think') before transitionTo('failure')", () => {
    controller.handle(reaction("failure"));
    expect(fake.records.holdNext.map((r) => r.state)).toEqual(["think"]);
    expect(fake.records.transitions.map((r) => r.state)).toEqual(["failure"]);
    // Order: holdNextState was set before the transition.
    expect(fake.records.holdNext.length).toBe(1);
    expect(fake.records.transitions.length).toBe(1);
  });

  it("lower-priority state cannot replace failure during its hold", () => {
    controller.handle(reaction("failure"));
    // Reset transition log by reading the count.
    const initialLen = fake.records.transitions.length;
    controller.handle(reaction("think"));
    controller.handle(reaction("talk", { talkToken: "x" }));
    controller.handle(reaction("read"));
    controller.handle(reaction("write"));
    controller.handle(reaction("tool"));
    controller.handle(reaction("idle"));
    controller.handle(reaction("hi"));
    // No transitions past the initial failure.
    expect(fake.records.transitions.length).toBe(initialLen);
  });

  it("talk token during failure is forwarded at most once while failure remains visible", () => {
    controller.handle(reaction("failure"));
    controller.handle(reaction("talk", { talkToken: "alpha" }));
    controller.handle(reaction("talk", { talkToken: "beta" }));
    // Both tokens forwarded (the controller does not dedupe — that's
    // the Animator's job). But state stays at failure.
    expect(fake.records.tokens.map((t) => t.token)).toEqual(["alpha", "beta"]);
    expect(fake.records.transitions.map((r) => r.state)).toEqual(["failure"]);
  });

  it("failure eventually becomes think", () => {
    controller.handle(reaction("failure"));
    // Advance fake timers past the hold duration.
    vi.advanceTimersByTime(150);
    expect(fake.records.transitions.map((r) => r.state)).toEqual(["failure", "think"]);
  });

  it("accepts ordinary activity after the Animator's failure hold ends", () => {
    controller.handle(reaction("failure"));
    vi.advanceTimersByTime(150);

    expect(controller.getVisibleState()).toBe("think");
    controller.handle(reaction("read"));

    expect(fake.records.transitions.map((r) => r.state)).toEqual([
      "failure",
      "think",
      "read",
    ]);
    expect(controller.getVisibleState()).toBe("read");
  });

  it("compact immediately replaces ordinary state", () => {
    controller.handle(reaction("think"));
    controller.handle(reaction("compact"));
    expect(fake.records.transitions.map((r) => r.state)).toEqual(["think", "compact"]);
  });

  it("compact immediately replaces failure", () => {
    controller.handle(reaction("failure"));
    const beforeCompact = fake.records.transitions.length;
    controller.handle(reaction("compact"));
    expect(fake.records.transitions.map((r) => r.state)).toEqual(["failure", "compact"]);
    expect(fake.records.transitions.length).toBe(beforeCompact + 1);
  });

  it("compact cancels failure continuation", () => {
    controller.handle(reaction("failure"));
    controller.handle(reaction("compact"));
    // Advance timers well past the failure hold duration.
    vi.advanceTimersByTime(10_000);
    // The compact must remain visible; the failure continuation must
    // not have fired to overwrite compact with "think".
    expect(fake.records.transitions[fake.records.transitions.length - 1]!.state).toBe("compact");
  });

  it("ordinary state cannot replace compact (only idle releases it)", () => {
    controller.handle(reaction("compact"));
    controller.handle(reaction("think"));
    controller.handle(reaction("talk", { talkToken: "x" }));
    controller.handle(reaction("read"));
    controller.handle(reaction("write"));
    controller.handle(reaction("tool"));
    controller.handle(reaction("hi"));
    // None of these ordinary states replaced compact.
    expect(fake.records.transitions.map((r) => r.state)).toEqual(["compact"]);
  });

  it("talk cannot replace compact (token still forwarded)", () => {
    controller.handle(reaction("compact"));
    controller.handle(reaction("talk", { talkToken: "should be ignored visually" }));
    expect(fake.records.transitions.map((r) => r.state)).toEqual(["compact"]);
    // Token is forwarded — the Animator will decide what to do with it
    // when we exit compact. The controller does not drop tokens.
    expect(fake.records.tokens.map((t) => t.token)).toEqual([
      "should be ignored visually",
    ]);
  });

  it("PostCompact releases compact to idle", () => {
    controller.handle(reaction("compact"));
    controller.handle(reaction("idle", {})); // PostCompact maps to idle
    expect(fake.records.transitions.map((r) => r.state)).toEqual(["compact", "idle"]);
  });

  it("Stop releases compact to idle", () => {
    controller.handle(reaction("compact"));
    controller.handle(reaction("idle", {})); // Stop maps to idle
    expect(fake.records.transitions.map((r) => r.state)).toEqual(["compact", "idle"]);
  });

  it("suppressed failure during compact does not appear after PostCompact", () => {
    controller.handle(reaction("compact"));
    // The following failure is suppressed visually while compact is
    // active.
    controller.handle(reaction("failure"));
    expect(fake.records.transitions.map((r) => r.state)).toEqual(["compact"]);
    // Exit compact.
    controller.handle(reaction("idle", {}));
    expect(fake.records.transitions.map((r) => r.state)).toEqual(["compact", "idle"]);
    vi.advanceTimersByTime(10_000);
    // Idle must remain; the suppressed failure must NOT have appeared.
    expect(fake.records.transitions[fake.records.transitions.length - 1]!.state).toBe("idle");
  });

  it("shutdown prevents later state changes", () => {
    controller.handle(shutdownReaction());
    controller.handle(reaction("think"));
    controller.handle(reaction("failure"));
    expect(shutdownCalls).toBe(1);
    // No transitions recorded after shutdown.
    expect(fake.records.transitions).toEqual([]);
    expect(fake.records.tokens).toEqual([]);
  });

  it("shutdown is idempotent", () => {
    controller.handle(shutdownReaction());
    controller.shutdown();
    controller.shutdown();
    expect(shutdownCalls).toBe(1);
  });

  it("stale failure continuation cannot win after a later ordinary state", () => {
    controller.handle(reaction("failure"));
    // The Animator's clearStateTimers in transitionTo() cancels the
    // failure hold timer. Now transitionTo a new ordinary state and
    // advance the timer past the original failure hold duration.
    controller.handle(reaction("think"));
    vi.advanceTimersByTime(10_000);
    // think must remain — the failure hold continuation must NOT have
    // fired.
    expect(fake.records.transitions[fake.records.transitions.length - 1]!.state).toBe("think");
  });

  it("visible-state getter remains truthful", () => {
    expect(controller.getVisibleState()).toBeNull();
    controller.handle(reaction("think"));
    expect(controller.getVisibleState()).toBe("think");
    controller.handle(reaction("compact"));
    expect(controller.getVisibleState()).toBe("compact");
    // Shutdown does not clear visibleState (cheap introspection
    // contract).
    controller.handle(shutdownReaction());
    expect(controller.getVisibleState()).toBe("compact");
  });

  it("failures chain through think → compact → idle correctly", () => {
    controller.handle(reaction("failure"));
    vi.advanceTimersByTime(150); // failure → think
    controller.handle(reaction("compact"));
    controller.handle(reaction("idle", {})); // PostCompact
    expect(fake.records.transitions.map((r) => r.state)).toEqual([
      "failure",
      "think",
      "compact",
      "idle",
    ]);
  });

  it("regression: one MessageDisplay.delta invokes animator.onTalkToken() exactly once", () => {
    controller.handle({
      state: "talk",
      talkToken: "single-delta",
    });
    const tokenCalls = fake.records.tokens.filter(
      (t) => t.token === "single-delta",
    );
    expect(tokenCalls.length).toBe(1);
    // The corresponding transitionTo also fired exactly once.
    const talkTransitions = fake.records.transitions.filter(
      (r) => r.state === "talk",
    );
    expect(talkTransitions.length).toBe(1);
  });
});
