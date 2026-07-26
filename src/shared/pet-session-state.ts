/**
 * Privacy-minimal protocol shared by the Node session host and desktop pet.
 *
 * Do not add prompt text, model output, tool arguments, tool results, paths,
 * environment values, or provider credentials to this contract.
 */

export const PET_ACTIVITIES = [
  "greeting",
  "idle",
  "thinking",
  "reading",
  "writing",
  "tooling",
  "talking",
  "compacting",
  "failure",
] as const;

export const PET_SESSION_STATUSES = [
  "running",
  "needs-input",
  "ready",
  "blocked",
  "ended",
  "disconnected",
] as const;

export type PetActivity = (typeof PET_ACTIVITIES)[number];
export type PetSessionStatus = (typeof PET_SESSION_STATUSES)[number];

export interface PetSessionState {
  sessionId: string;
  sequence: number;
  status: PetSessionStatus;
  activity: PetActivity;
  timestamp: number;
}

const ACTIVITY_SET = new Set<string>(PET_ACTIVITIES);
const STATUS_SET = new Set<string>(PET_SESSION_STATUSES);
const STATE_KEYS = new Set([
  "sessionId",
  "sequence",
  "status",
  "activity",
  "timestamp",
]);

export function isPetSessionState(value: unknown): value is PetSessionState {
  if (typeof value !== "object" || value === null) return false;
  if (Object.keys(value).some((key) => !STATE_KEYS.has(key))) return false;
  const candidate = value as Partial<PetSessionState>;
  return (
    typeof candidate.sessionId === "string" &&
    candidate.sessionId.length > 0 &&
    typeof candidate.sequence === "number" &&
    Number.isSafeInteger(candidate.sequence) &&
    candidate.sequence >= 0 &&
    typeof candidate.status === "string" &&
    STATUS_SET.has(candidate.status) &&
    typeof candidate.activity === "string" &&
    ACTIVITY_SET.has(candidate.activity) &&
    typeof candidate.timestamp === "number" &&
    Number.isFinite(candidate.timestamp)
  );
}

export function parsePetSessionState(value: unknown): PetSessionState {
  if (!isPetSessionState(value)) {
    throw new Error("Invalid Claude Pet session-state update");
  }
  return value;
}

