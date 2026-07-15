/**
 * hooks-schema.test.ts
 *
 * Validates the structural shape of hooks/hooks.json against the current
 * Claude Code plugin manifest format. The validator expects:
 *
 *   { event: [ { hooks: [ { type, command, args, timeout } ] } ] }
 *
 * — not the older flat shape where the command handler is placed directly
 * inside the event array.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HOOKS_PATH = join(process.cwd(), "hooks", "hooks.json");

interface CommandHandler {
  type: string;
  command: string;
  args: string[];
  timeout: number;
}

interface MatcherGroup {
  hooks: CommandHandler[];
}

type HooksConfig = Record<string, MatcherGroup[]>;

const SUPPORTED_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "MessageDisplay",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "PermissionRequest",
  "PermissionDenied",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "Stop",
  "StopFailure",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
];

describe("hooks/hooks.json (P1)", () => {
  const raw = readFileSync(HOOKS_PATH, "utf8");
  const parsed = JSON.parse(raw) as { hooks: HooksConfig };

  it("is valid JSON and has a top-level `hooks` object", () => {
    expect(parsed.hooks).toBeTypeOf("object");
  });

  it.each(SUPPORTED_EVENTS)("event %s is an array of matcher groups", (event) => {
    const value = parsed.hooks[event];
    expect(value).toBeDefined();
    expect(Array.isArray(value)).toBe(true);
  });

  it.each(SUPPORTED_EVENTS)(
    "event %s has an inner `hooks` array on every matcher group",
    (event) => {
      for (const group of parsed.hooks[event]) {
        expect(group.hooks).toBeDefined();
        expect(Array.isArray(group.hooks)).toBe(true);
      }
    },
  );

  it.each(SUPPORTED_EVENTS)(
    "every command handler for %s has type, command, args, timeout",
    (event) => {
      for (const group of parsed.hooks[event]) {
        for (const handler of group.hooks) {
          expect(handler.type).toBe("command");
          expect(typeof handler.command).toBe("string");
          expect(Array.isArray(handler.args)).toBe(true);
          expect(typeof handler.timeout).toBe("number");
        }
      }
    },
  );

  it("no event has a command handler placed directly in the event array", () => {
    for (const event of SUPPORTED_EVENTS) {
      for (const entry of parsed.hooks[event]) {
        // The outer entry must NOT itself be a command handler.
        expect(entry.type).toBeUndefined();
        expect(entry.command).toBeUndefined();
      }
    }
  });

  it("every event handler points at dist/claude/hook-bridge.js", () => {
    for (const event of SUPPORTED_EVENTS) {
      for (const group of parsed.hooks[event]) {
        for (const handler of group.hooks) {
          expect(handler.command).toBe("node");
          expect(handler.args).toContain(
            "${CLAUDE_PLUGIN_ROOT}/dist/claude/hook-bridge.js",
          );
        }
      }
    }
  });
});
