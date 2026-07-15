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

  it("MessageDisplay delta emits a non-empty talk token", () => {
    const fixture = loadFixture("MessageDisplay_delta.json") as HookEvent;
    const reaction = mapEvent(fixture);
    expect(reaction.talkToken).toBe("Here is the next part of the response.");
  });

  it("MessageDisplay final does NOT emit a talk token (only type=delta feeds tokens)", () => {
    const fixture = loadFixture("MessageDisplay_final.json") as HookEvent;
    const reaction = mapEvent(fixture);
    expect(reaction.state).toBe("talk");
    expect(reaction.talkToken).toBeUndefined();
  });

  it("MessageDisplay empty delta still maps to talk", () => {
    const fixture = loadFixture("MessageDisplay_empty_delta.json") as HookEvent;
    const reaction = mapEvent(fixture);
    expect(reaction.state).toBe("talk");
    // Empty content may still be a token (the Animator decides what to do
    // with zero words), but we forward it as-is.
    expect(reaction.talkToken).toBe("");
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
