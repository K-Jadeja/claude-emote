/**
 * event-mapper.ts
 *
 * Single source of truth for the mapping from Claude Code hook events to
 * upstream `EmoteState`s and animator token events.
 *
 * Why one file:
 *   Per the project specification, mapping logic must not be spread across
 *   hooks, the launcher, or the renderer. Anything that turns a Claude
 *   event into an avatar reaction must funnel through `mapEvent()`.
 *
 * The mapper is intentionally *declarative* — it emits a target state
 * plus, for MessageDisplay, a talk token. It does NOT own transient
 * state, timers, or priority decisions. Those responsibilities live
 * in src/host/avatar-state-controller.ts (Phase 7). For example, the
 * mapper says "PostToolUseFailure → failure" but does not know that
 * failure should be held for a duration or that it should transition
 * to "think" afterwards; the state controller enforces those rules.
 */

import type { EmoteState } from "../core/types.js";
import {
  type HookEvent,
  READ_TOOLS,
  WRITE_TOOLS,
} from "./hook-event.js";

export interface AvatarReaction {
  /** The avatar state to transition to. `null` means "no change". */
  state: EmoteState | null;
  /**
   * Optional talk token to feed to the Animator. Currently only emitted
   * for MessageDisplay delta events.
   */
  talkToken?: string;
  /** Whether the avatar process should shut down (SessionEnd only). */
  shutdown?: boolean;
}

/**
 * Tool-name -> avatar-state. Anything not listed falls back to "tool".
 */
function toolState(toolName: string): EmoteState {
  if (READ_TOOLS.has(toolName)) return "read";
  if (WRITE_TOOLS.has(toolName)) return "write";
  return "tool";
}

/**
 * Map a single Claude hook event to an avatar reaction.
 *
 * Returns `{state: null}` for events the mapper intentionally ignores so
 * the caller can distinguish "no opinion" from "definitely transition".
 */
export function mapEvent(event: HookEvent): AvatarReaction {
  switch (event.hook_event_name) {
    case "SessionStart":
      // Spec: hi, followed by normal animator transition to idle.
      return { state: "hi" };

    case "UserPromptSubmit":
      return { state: "think" };

    case "MessageDisplay": {
      // Always transition to talk. The Animator's own duration timer owns
      // the transition back to idle; `Stop` is the only other event that
      // can end the turn. The talk token is forwarded verbatim; the
      // Animator's onTalkToken() handles zero-length deltas. Defensive
      // against missing fields so the bridge never crashes on bad input.
      const delta = (event as { delta?: unknown }).delta;
      return {
        state: "talk",
        talkToken: typeof delta === "string" && delta.length > 0 ? delta : undefined,
      };
    }

    case "PreToolUse":
      return { state: toolState(event.tool_name) };

    case "PostToolUse":
      // Spec: transient read, then think. We emit think here because the
      // Animator's normal state transitions cover the visual cycle; the
      // "transient read" comes from the prior PreToolUse cycle ending.
      return { state: "think" };

    case "PostToolUseFailure":
      return { state: "failure" };

    case "PostToolBatch":
      return { state: "think" };

    case "PermissionRequest":
      // V1: think. Permission decisions come via PermissionDenied / decision callbacks.
      return { state: "think" };

    case "PermissionDenied":
      return { state: "failure" };

    case "SubagentStart":
      return { state: "tool" };

    case "SubagentStop":
      return { state: "think" };

    case "TaskCreated":
      return { state: "tool" };

    case "TaskCompleted":
      return { state: "think" };

    case "PreCompact":
      return { state: "compact" };

    case "PostCompact":
      return { state: "idle" };

    case "Stop":
      return { state: "idle" };

    case "StopFailure":
      return { state: "failure" };

    case "SessionEnd":
      return { state: null, shutdown: true };

    default:
      // Unknown / future event names: ignore but never throw.
      return { state: null };
  }
}

/**
 * Convenience wrapper that tolerates malformed input. The bridge always
 * feeds raw JSON to this function so we never throw out of the mapper.
 *
 * Structural validation:
 *   - Non-object / missing hook_event_name → { state: null }
 *   - Unknown event name → { state: null } (default case)
 *   - Known event name but required fields missing → { state: null }
 *     (the mapper does NOT silently coerce a bad MessageDisplay into a
 *     "talk" reaction when the turn_id / message_id / index / final /
 *     delta fields are absent).
 */
export function mapEventSafe(raw: unknown): AvatarReaction {
  if (!raw || typeof raw !== "object") return { state: null };
  const obj = raw as Record<string, unknown>;
  const name = obj.hook_event_name;
  if (typeof name !== "string") return { state: null };

  // Per-event structural checks. Unknown names fall through to mapEvent
  // (which has a default case returning {state: null}).
  switch (name) {
    case "MessageDisplay":
      if (
        typeof obj.turn_id !== "string" ||
        typeof obj.message_id !== "string" ||
        typeof obj.index !== "number" ||
        typeof obj.final !== "boolean" ||
        typeof obj.delta !== "string"
      ) {
        return { state: null };
      }
      break;
    case "SessionStart":
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
    case "PostToolBatch":
    case "PermissionRequest":
    case "PermissionDenied":
    case "SubagentStart":
    case "SubagentStop":
    case "TaskCreated":
    case "TaskCompleted":
    case "Stop":
    case "StopFailure":
    case "PreCompact":
    case "PostCompact":
    case "SessionEnd":
      if (typeof obj.session_id !== "string") return { state: null };
      break;
  }

  return mapEvent(obj as unknown as HookEvent);
}
