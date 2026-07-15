import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { mapEvent, mapEventSafe } from "../../src/claude/event-mapper.js";
import type { HookEvent } from "../../src/claude/hook-event.js";

const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
}

/**
 * Per the spec, every fixture must map to the documented state. This table
 * is the contract. If the mapper ever changes, this table is the single
 * place that needs to be reviewed and updated.
 */
const EXPECTED: Record<string, { state: string | null; shutdown?: boolean }> = {
  SessionStart: { state: "hi" },
  UserPromptSubmit: { state: "think" },
  MessageDisplay_delta: { state: "talk" },
  MessageDisplay_final: { state: "talk" },
  MessageDisplay_empty_delta: { state: "talk" },
  MessageDisplay_final_empty: { state: "talk" },
  PreToolUse_Read: { state: "read" },
  PreToolUse_Glob: { state: "read" },
  PreToolUse_Grep: { state: "read" },
  PreToolUse_WebFetch: { state: "read" },
  PreToolUse_WebSearch: { state: "read" },
  PreToolUse_Edit: { state: "write" },
  PreToolUse_Write: { state: "write" },
  PreToolUse_Bash: { state: "tool" },
  PostToolUse: { state: "think" },
  PostToolUseFailure: { state: "failure" },
  PostToolBatch: { state: "think" },
  PermissionRequest: { state: "think" },
  PermissionDenied: { state: "failure" },
  SubagentStart: { state: "tool" },
  SubagentStop: { state: "think" },
  TaskCreated: { state: "tool" },
  TaskCompleted: { state: "think" },
  Stop: { state: "idle" },
  StopFailure: { state: "failure" },
  PreCompact: { state: "compact" },
  PostCompact: { state: "idle" },
  SessionEnd: { state: null, shutdown: true },
};

describe("EventMapper (M3)", () => {
  const fixtureFiles = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => !f.startsWith("malformed"))
    .sort();

  for (const f of fixtureFiles) {
    const stem = basename(f, ".json");
    const expected = EXPECTED[stem];
    if (!expected) {
      // Defensive: a fixture without a contract entry is a test bug.
      it.skip(`[unmapped] ${stem}`, () => {});
      continue;
    }
    it(`maps ${stem} -> ${expected.state ?? "(shutdown)"}`, () => {
      const fixture = loadFixture(f) as HookEvent;
      const reaction = mapEvent(fixture);
      expect(reaction.state).toBe(expected.state);
      if (expected.shutdown !== undefined) {
        expect(!!reaction.shutdown).toBe(expected.shutdown);
      }
    });
  }

  it("MessageDisplay non-final with non-empty delta emits a non-empty talk token", () => {
    const fixture = loadFixture("MessageDisplay_delta.json") as HookEvent;
    const reaction = mapEvent(fixture);
    expect(reaction.state).toBe("talk");
    expect(reaction.talkToken).toBe("Here is the next part of the response.");
  });

  it("MessageDisplay final with non-empty delta still emits a non-empty talk token (final does not suppress the token)", () => {
    const fixture = loadFixture("MessageDisplay_final.json") as HookEvent;
    const reaction = mapEvent(fixture);
    expect(reaction.state).toBe("talk");
    expect(reaction.talkToken).toBe("Here is the final response.");
  });

  it("MessageDisplay final with empty delta still maps to talk without a token", () => {
    const fixture = loadFixture("MessageDisplay_final_empty.json") as HookEvent;
    const reaction = mapEvent(fixture);
    expect(reaction.state).toBe("talk");
    expect(reaction.talkToken).toBeUndefined();
  });

  it("MessageDisplay non-final with empty delta maps to talk without a token (ignored for mouth accounting)", () => {
    const fixture = loadFixture("MessageDisplay_empty_delta.json") as HookEvent;
    const reaction = mapEvent(fixture);
    expect(reaction.state).toBe("talk");
    expect(reaction.talkToken).toBeUndefined();
  });

  it("multiple MessageDisplay events sharing the same message_id all map to talk", () => {
    for (const name of [
      "MessageDisplay_delta.json",
      "MessageDisplay_final.json",
      "MessageDisplay_empty_delta.json",
    ]) {
      const reaction = mapEvent(loadFixture(name) as HookEvent);
      expect(reaction.state).toBe("talk");
    }
  });

  it("malformed MessageDisplay input fails open (does not throw)", () => {
    // Per the spec, the bridge / mapper must not crash on malformed
    // input. The mapper is allowed to return any state; the contract is
    // simply that the call resolves.
    const bad = {
      hook_event_name: "MessageDisplay",
      session_id: "x",
      // missing turn_id, message_id, index, final, delta
    };
    expect(() => mapEvent(bad as unknown as HookEvent)).not.toThrow();
    const reaction = mapEvent(bad as unknown as HookEvent);
    expect(reaction).toBeDefined();
    // Empty / missing delta is treated as no talk token; the avatar still
    // transitions to talk because the event name matched.
    expect(reaction.talkToken).toBeUndefined();
  });

  it("mapEventSafe tolerates malformed input without throwing", () => {
    expect(mapEventSafe(null).state).toBeNull();
    expect(mapEventSafe({}).state).toBeNull();
    expect(mapEventSafe({ hook_event_name: "UnknownEvent" }).state).toBeNull();
    const r = mapEventSafe(loadFixture("malformed.json"));
    expect(r.state).toBeNull();
    const r2 = mapEventSafe(loadFixture("malformed_no_name.json"));
    expect(r2.state).toBeNull();
  });

  it("SessionEnd sets shutdown=true and does not transition state", () => {
    const fixture = loadFixture("SessionEnd.json") as HookEvent;
    const reaction = mapEvent(fixture);
    expect(reaction.state).toBeNull();
    expect(reaction.shutdown).toBe(true);
  });
});
