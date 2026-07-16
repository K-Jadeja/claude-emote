/**
 * emote-validation.ts
 *
 * Phase 6: one adapter-level validator that determines whether an
 * emote directory is compatible with a chosen renderer kind. Lives in
 * src/shared/ so both the avatar host and the (eventual) launcher can
 * reach it without importing renderer internals.
 *
 * The validator never throws on bad input — it returns a structured
 * EmoteValidationResult so callers can produce their own error
 * messages with their own prefixes.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { discoverFrames } from "../core/emotes.js";
import type { EmoteState } from "../core/types.js";

export type RendererKind = "ascii" | "image";

export interface EmoteValidationResult {
  ok: boolean;
  /** Human-readable reason. Undefined when ok is true. */
  reason?: string;
  /** Number of usable frames discovered. */
  frameCount: number;
}

const ASCII_REQUIRED_STATES: EmoteState[] = [
  "hi",
  "idle",
  "think",
  "talk",
  "read",
  "write",
  "tool",
  "failure",
  "compact",
];

/**
 * Count the number of parsed frames in an ascii.yaml by reading the
 * file and counting non-blank, non-comment lines that look like
 * frame-bearing entries. This is a conservative count that mirrors
 * how AsciiRenderer parses the file (one entry per non-inline
 * top-level key, plus array items under each state). It is not a
 * re-implementation of the YAML parser — it is just enough to tell
 * the validator that the file is non-empty and contains at least
 * one usable frame.
 */
function countAsciiFrames(yamlText: string): { total: number; hasIdle: boolean } {
  let total = 0;
  let hasIdle = false;
  let currentKey: string | null = null;
  for (const raw of yamlText.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    const topMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (topMatch) {
      const value = topMatch[2]?.replace(/^["']|["']$/g, "").trim() ?? "";
      currentKey = topMatch[1] ?? null;
      if (value.length > 0) {
        // Inline scalar: hi: "(^ ◡ ^)/"
        total++;
        if (currentKey === "idle") hasIdle = true;
        currentKey = null;
      }
      continue;
    }
    if (currentKey === null) continue;
    // Array item under a state: "  - foo" — counts as one frame for
    // that state.
    if (/^\s+-\s+/.test(line)) {
      total++;
      if (currentKey === "idle") hasIdle = true;
      continue;
    }
    // Nested key under a state: "  default: foo" — counts as one
    // frame for the state.
    if (/^\s+\w[\w-]*:\s+/.test(line)) {
      total++;
      if (currentKey === "idle") hasIdle = true;
    }
  }
  return { total, hasIdle };
}

/**
 * Validate a directory as compatible with a given renderer kind.
 * Returns a structured result; never throws.
 */
export function validateEmoteDirectory(
  directory: string,
  rendererKind: RendererKind,
): EmoteValidationResult {
  if (!directory || typeof directory !== "string") {
    return { ok: false, reason: "directory path is empty", frameCount: 0 };
  }
  if (!existsSync(directory)) {
    return { ok: false, reason: `directory does not exist: ${directory}`, frameCount: 0 };
  }
  let stat;
  try {
    stat = statSync(directory);
  } catch (err) {
    return {
      ok: false,
      reason: `cannot stat directory: ${(err as Error).message}`,
      frameCount: 0,
    };
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: `not a directory: ${directory}`, frameCount: 0 };
  }

  if (rendererKind === "ascii") {
    const yamlPath = join(directory, "ascii.yaml");
    if (!existsSync(yamlPath)) {
      return {
        ok: false,
        reason: `ascii.yaml not found in ${directory}`,
        frameCount: 0,
      };
    }
    let text: string;
    try {
      text = readFileSync(yamlPath, "utf8");
    } catch (err) {
      return {
        ok: false,
        reason: `cannot read ascii.yaml: ${(err as Error).message}`,
        frameCount: 0,
      };
    }
    if (text.trim().length === 0) {
      return { ok: false, reason: `ascii.yaml is empty: ${yamlPath}`, frameCount: 0 };
    }
    const { total, hasIdle } = countAsciiFrames(text);
    if (total === 0) {
      return {
        ok: false,
        reason: `ascii.yaml contains no usable frames: ${yamlPath}`,
        frameCount: 0,
      };
    }
    // Treat "idle present" as a soft requirement: missing idle means
    // initial-state readiness will fail later. Surface it here so the
    // caller can decide.
    return { ok: true, frameCount: total, reason: hasIdle ? undefined : "idle state missing in ascii.yaml" };
  }

  // Image renderer.
  // Use the existing discovery function from src/core/emotes.ts so
  // we do not duplicate recursive scan logic.
  const frameMap = discoverFrames(directory);
  let total = 0;
  for (const [, fs] of frameMap) {
    total += fs.files.length;
  }
  if (total === 0) {
    return {
      ok: false,
      reason: `no usable PNG frames found in ${directory}`,
      frameCount: 0,
    };
  }
  // Idle is the required initial state.
  const idleFiles = frameMap.get("idle" as EmoteState)?.files ?? [];
  if (idleFiles.length === 0) {
    return {
      ok: false,
      reason: `image emote set has no idle frames in ${directory}`,
      frameCount: total,
    };
  }
  return { ok: true, frameCount: total };
}

/** The states required at minimum for a usable initial frame. */
export const REQUIRED_INITIAL_STATES: EmoteState[] = ASCII_REQUIRED_STATES;