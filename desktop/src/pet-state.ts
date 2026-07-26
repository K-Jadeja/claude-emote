import manifestJson from "../asset-manifest.json";
import {
  PET_ACTIVITIES,
  isPetSessionState,
  parsePetSessionState,
  type PetActivity,
  type PetSessionState,
  type PetSessionStatus,
} from "../../src/shared/pet-session-state";

export const ACTIVITIES = PET_ACTIVITIES;
export type Activity = PetActivity;
export type SessionStatus = PetSessionStatus;
export type PetState = PetSessionState;
export {
  isPetSessionState as isPetState,
  parsePetSessionState as parsePetState,
};

interface ManifestActivity {
  label: string;
  intervalMs: number;
  frames: string[];
}

interface AssetManifest {
  id: string;
  displayName: string;
  license: string;
  activities: Record<Activity, ManifestActivity>;
}

export interface Pose {
  activity: Activity;
  label: string;
  intervalMs: number;
  frames: string[];
}

const manifest = manifestJson as AssetManifest;

export const STATUS_LABELS: Record<SessionStatus, string> = {
  running: "running",
  "needs-input": "needs you",
  ready: "ready",
  blocked: "blocked",
  ended: "session ended",
  disconnected: "disconnected",
};

export function getPose(activity: Activity): Pose {
  const entry = manifest.activities[activity];
  if (!entry || entry.frames.length === 0) {
    throw new Error(`Asset manifest has no frames for activity "${activity}"`);
  }
  return {
    activity,
    label: entry.label,
    intervalMs: entry.intervalMs,
    frames: entry.frames.map((path) => `./assets/default/${path}`),
  };
}

export function createDemoStates(now = Date.now()): PetState[] {
  const entries: Array<[Activity, SessionStatus]> = [
    ["greeting", "running"],
    ["idle", "ready"],
    ["thinking", "running"],
    ["reading", "running"],
    ["writing", "running"],
    ["tooling", "running"],
    ["talking", "running"],
    ["compacting", "running"],
    ["failure", "blocked"],
  ];
  return entries.map(([activity, status], index) => ({
    sessionId: "demo",
    sequence: index + 1,
    status,
    activity,
    timestamp: now + index,
  }));
}
