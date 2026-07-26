/**
 * event-state-sequences.test.ts (P7)
 *
 * Sequence tests using the REAL mapEventSafe() and the REAL state
 * controller. A recording Animator port captures every transition
 * and talk-token call so tests can assert the exact timeline.
 *
 * No renderer, no terminal, no timer-based heuristics. Fake timers
 * drive the Animator's hold continuation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mapEventSafe } from "../../src/claude/event-mapper.js";
import { createAvatarStateController } from "../../src/host/avatar-state-controller.js";
import type { EmoteState } from "../../src/core/types.js";

interface Transition { state: EmoteState; at: number }
interface TokenCall { token: string; at: number }
interface HoldNext { state: EmoteState; at: number }
interface Fake {
  transitions: Transition[];
  tokens: TokenCall[];
  holdNext: HoldNext[];
  holdNextState: EmoteState;
  holdTimer: ReturnType<typeof setTimeout> | null;
  tick: number;
  shutdownCalls: number;
  currentState: EmoteState;
  transitionTo(state: EmoteState): void;
  onTalkToken(token: string): void;
  getCurrentState(): EmoteState;
  setHoldNextState(state: EmoteState): void;
}

function makeFake(): Fake {
  const fake: Fake = {
    transitions: [],
    tokens: [],
    holdNext: [],
    holdNextState: "idle",
    holdTimer: null,
    tick: 0,
    shutdownCalls: 0,
    currentState: "idle",
    transitionTo(state) {
      fake.currentState = state;
      fake.transitions.push({ state, at: fake.tick++ });
      if (fake.holdTimer) {
        clearTimeout(fake.holdTimer);
        fake.holdTimer = null;
      }
      if (state === "failure" || state === "success") {
        fake.holdTimer = setTimeout(() => fake.transitionTo(fake.holdNextState), 80);
      }
    },
    onTalkToken(token) {
      fake.tokens.push({ token, at: fake.tick++ });
    },
    getCurrentState() {
      return fake.currentState;
    },
    setHoldNextState(state) {
      fake.holdNext.push({ state, at: fake.tick++ });
      fake.holdNextState = state;
    },
  };
  return fake;
}

describe("hook event → state controller sequences (P7)", () => {
  let fake: Fake;

  beforeEach(() => {
    vi.useFakeTimers();
    fake = makeFake();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function controller() {
    return createAvatarStateController({
      animator: {
        transitionTo: (s) => fake.transitionTo(s),
        onTalkToken: (t) => fake.onTalkToken(t),
        getCurrentState: () => fake.getCurrentState(),
        setHoldNextState: (s) => fake.setHoldNextState(s),
      },
      onShutdown: () => { fake.shutdownCalls++; },
    });
  }

  it("PostToolUseFailure → PostToolBatch → (hold ends) → think", () => {
    const c = controller();
    c.handle(mapEventSafe({
      hook_event_name: "PostToolUseFailure",
      session_id: "s",
      tool_name: "Bash",
    }));
    c.handle(mapEventSafe({
      hook_event_name: "PostToolBatch",
      session_id: "s",
    }));
    expect(fake.transitions.map((t) => t.state)).toEqual(["failure"]);
    vi.advanceTimersByTime(150);
    expect(fake.transitions.map((t) => t.state)).toEqual(["failure", "think"]);
  });

  it("PermissionDenied → MessageDisplay: failure visible, token forwarded", () => {
    const c = controller();
    c.handle(mapEventSafe({
      hook_event_name: "PermissionDenied",
      session_id: "s",
      tool_name: "Bash",
    }));
    c.handle(mapEventSafe({
      hook_event_name: "MessageDisplay",
      session_id: "s",
      turn_id: "t",
      message_id: "m",
      index: 0,
      final: false,
      delta: "streamed response",
    }));
    expect(fake.transitions.map((t) => t.state)).toEqual(["failure"]);
    expect(fake.tokens.map((t) => t.token)).toEqual(["streamed response"]);
    vi.advanceTimersByTime(150);
    expect(fake.transitions.map((t) => t.state)).toEqual(["failure", "think"]);
  });

  it("PreCompact → MessageDisplay → PostCompact: compact visible, idle release", () => {
    const c = controller();
    c.handle(mapEventSafe({
      hook_event_name: "PreCompact",
      session_id: "s",
    }));
    c.handle(mapEventSafe({
      hook_event_name: "MessageDisplay",
      session_id: "s",
      turn_id: "t",
      message_id: "m",
      index: 0,
      final: false,
      delta: "should be ignored visually",
    }));
    expect(fake.transitions.map((t) => t.state)).toEqual(["compact"]);
    expect(fake.tokens.map((t) => t.token)).toEqual(["should be ignored visually"]);
    c.handle(mapEventSafe({
      hook_event_name: "PostCompact",
      session_id: "s",
    }));
    expect(fake.transitions.map((t) => t.state)).toEqual(["compact", "idle"]);
  });

  it("normal turn: think → read → think → talk → idle", () => {
    const c = controller();
    c.handle(mapEventSafe({ hook_event_name: "UserPromptSubmit", session_id: "s" }));
    c.handle(mapEventSafe({
      hook_event_name: "PreToolUse",
      session_id: "s",
      tool_name: "Read",
    }));
    c.handle(mapEventSafe({
      hook_event_name: "PostToolUse",
      session_id: "s",
      tool_name: "Read",
    }));
    c.handle(mapEventSafe({
      hook_event_name: "MessageDisplay",
      session_id: "s",
      turn_id: "t",
      message_id: "m",
      index: 0,
      final: false,
      delta: "answer",
    }));
    c.handle(mapEventSafe({ hook_event_name: "Stop", session_id: "s" }));
    expect(fake.transitions.map((t) => t.state)).toEqual([
      "think",
      "read",
      "think",
      "talk",
      "idle",
    ]);
    expect(fake.tokens.map((t) => t.token)).toEqual(["answer"]);
  });

  it("failure followed by compact immediately", () => {
    const c = controller();
    c.handle(mapEventSafe({
      hook_event_name: "PostToolUseFailure",
      session_id: "s",
      tool_name: "Bash",
    }));
    c.handle(mapEventSafe({
      hook_event_name: "PreCompact",
      session_id: "s",
    }));
    expect(fake.transitions.map((t) => t.state)).toEqual(["failure", "compact"]);
    vi.advanceTimersByTime(500);
    expect(fake.transitions[fake.transitions.length - 1]!.state).toBe("compact");
  });

  it("compact followed by failure: failure is suppressed", () => {
    const c = controller();
    c.handle(mapEventSafe({ hook_event_name: "PreCompact", session_id: "s" }));
    c.handle(mapEventSafe({
      hook_event_name: "PostToolUseFailure",
      session_id: "s",
      tool_name: "Bash",
    }));
    c.handle(mapEventSafe({ hook_event_name: "PostCompact", session_id: "s" }));
    expect(fake.transitions.map((t) => t.state)).toEqual(["compact", "idle"]);
    vi.advanceTimersByTime(500);
    expect(fake.transitions[fake.transitions.length - 1]!.state).toBe("idle");
  });

  it("SessionStart → UserPromptSubmit → Stop → SessionEnd", () => {
    const c = controller();
    c.handle(mapEventSafe({ hook_event_name: "SessionStart", session_id: "s" }));
    c.handle(mapEventSafe({ hook_event_name: "UserPromptSubmit", session_id: "s" }));
    c.handle(mapEventSafe({ hook_event_name: "Stop", session_id: "s" }));
    expect(fake.transitions.map((t) => t.state)).toEqual(["hi", "think", "idle"]);
    expect(fake.shutdownCalls).toBe(0);
    c.handle(mapEventSafe({ hook_event_name: "SessionEnd", session_id: "s" }));
    expect(fake.shutdownCalls).toBe(1);
    // After shutdown, no transitions recorded.
    expect(fake.transitions.map((t) => t.state)).toEqual(["hi", "think", "idle"]);
  });
});
