import { describe, expect, it, vi } from "vitest";
import { createPetSessionStateTracker } from "../../src/host/pet-session-state-tracker";

describe("pet session-state tracker", () => {
  it("maps a production-shaped turn without copying private event fields", () => {
    const tracker = createPetSessionStateTracker("host-instance", () => 1234);
    const published = vi.fn();
    tracker.subscribe(published);

    const state = tracker.apply(
      {
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        tool_name: "Read",
        tool_input: { file_path: "C:/private/secret.txt" },
        prompt: "private prompt",
      },
      { state: "read" },
    );

    expect(state).toEqual({
      sessionId: "session-1",
      sequence: 1,
      status: "running",
      activity: "reading",
      timestamp: 1234,
    });
    expect(Object.keys(state!)).toEqual([
      "sessionId",
      "sequence",
      "status",
      "activity",
      "timestamp",
    ]);
    expect(JSON.stringify(state)).not.toContain("private");
    expect(published).toHaveBeenCalledOnce();
  });

  it("distinguishes attention, ready, blocked, and ended statuses", () => {
    let timestamp = 100;
    const tracker = createPetSessionStateTracker("host", () => timestamp++);

    expect(
      tracker.apply(
        { hook_event_name: "PermissionRequest", session_id: "s" },
        { state: "think" },
      )?.status,
    ).toBe("needs-input");
    expect(
      tracker.apply(
        { hook_event_name: "PermissionDenied", session_id: "s" },
        { state: "failure" },
      )?.status,
    ).toBe("blocked");
    expect(
      tracker.apply(
        { hook_event_name: "Stop", session_id: "s" },
        { state: "idle" },
      )?.status,
    ).toBe("ready");
    expect(
      tracker.apply(
        { hook_event_name: "SessionEnd", session_id: "s" },
        { state: null, shutdown: true },
      )?.status,
    ).toBe("ended");
  });

  it("ignores unknown reactions and keeps sequence monotonic", () => {
    const tracker = createPetSessionStateTracker("host", () => 1000);
    expect(tracker.apply({ hook_event_name: "FutureEvent" }, { state: null })).toBeNull();
    expect(tracker.getSnapshot().sequence).toBe(0);

    tracker.apply(
      { hook_event_name: "SessionStart", session_id: "s" },
      { state: "hi" },
    );
    tracker.apply(
      { hook_event_name: "UserPromptSubmit", session_id: "s" },
      { state: "think" },
    );
    expect(tracker.getSnapshot().sequence).toBe(2);
  });
});
