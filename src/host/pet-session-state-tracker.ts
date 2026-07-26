import type { AvatarReaction } from "../claude/event-mapper.js";
import type { EmoteState } from "../core/types.js";
import type {
  PetActivity,
  PetSessionState,
  PetSessionStatus,
} from "../shared/pet-session-state.js";

export type PetSessionStateListener = (state: PetSessionState) => void;

export interface PetSessionStateTracker {
  getSnapshot(): PetSessionState;
  apply(rawEvent: unknown, reaction: AvatarReaction): PetSessionState | null;
  subscribe(listener: PetSessionStateListener): () => void;
}

const ACTIVITY_BY_EMOTE: Record<EmoteState, PetActivity> = {
  hi: "greeting",
  idle: "idle",
  think: "thinking",
  talk: "talking",
  read: "reading",
  write: "writing",
  tool: "tooling",
  success: "idle",
  failure: "failure",
  compact: "compacting",
};

function readString(
  value: unknown,
  key: "hook_event_name" | "session_id",
): string | null {
  if (typeof value !== "object" || value === null) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function statusForEvent(
  eventName: string | null,
  reaction: AvatarReaction,
): PetSessionStatus {
  if (reaction.shutdown || eventName === "SessionEnd") return "ended";
  if (eventName === "PermissionRequest") return "needs-input";
  if (
    reaction.state === "failure" ||
    eventName === "PermissionDenied" ||
    eventName === "PostToolUseFailure" ||
    eventName === "StopFailure"
  ) {
    return "blocked";
  }
  if (eventName === "Stop") return "ready";
  return "running";
}

export function createPetSessionStateTracker(
  instanceId: string,
  now: () => number = Date.now,
): PetSessionStateTracker {
  if (instanceId.length === 0) {
    throw new Error("Pet session-state tracker requires an instance ID");
  }
  let current: PetSessionState = {
    sessionId: instanceId,
    sequence: 0,
    status: "ready",
    activity: "idle",
    timestamp: now(),
  };
  const listeners = new Set<PetSessionStateListener>();

  function publish(next: PetSessionState): PetSessionState {
    current = next;
    for (const listener of listeners) listener(next);
    return next;
  }

  return {
    getSnapshot: () => current,
    apply(rawEvent, reaction) {
      const eventName = readString(rawEvent, "hook_event_name");
      const sessionId = readString(rawEvent, "session_id") ?? current.sessionId;

      if (reaction.shutdown) {
        return publish({
          sessionId,
          sequence: current.sequence + 1,
          status: "ended",
          activity: "idle",
          timestamp: now(),
        });
      }
      if (reaction.state === null) return null;

      return publish({
        sessionId,
        sequence: current.sequence + 1,
        status: statusForEvent(eventName, reaction),
        activity: ACTIVITY_BY_EMOTE[reaction.state],
        timestamp: now(),
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

