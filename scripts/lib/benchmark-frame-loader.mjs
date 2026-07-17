// scripts/lib/benchmark-frame-loader.mjs
//
// Phase 9B benchmark frame loader. Loads the bundled ASCII emote set
// from emotes/ascii/ascii.yaml using the maintained `yaml` package,
// which is the standard YAML parser used elsewhere in the Node
// ecosystem. This loader is intentionally scoped to the benchmark
// tooling boundary — production renderer code in src/core/ is
// untouched.
//
// Usage:
//   const frames = await loadBundledFrames();
//   const think = frames.think;          // string[]
//   const primaryThink = frames.primaryThink; // string — "default" frame

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(__filename), "..", "..");

const BUNDLED_ASCII_YAML = join(
  PROJECT_ROOT,
  "emotes",
  "ascii",
  "ascii.yaml",
);

/**
 * @typedef {{
 *   think: string[],
 *   idle: string[],
 *   talk: string[],
 *   read: string[],
 *   write: string[],
 *   failure: string[],
 *   compact: string[],
 *   primaryThink: string,
 *   sourceFile: string,
 *   loadedFrom: string,
 * }} BundledFrames
 */

/**
 * Collect the set of frame strings for a single state. A state's
 * representation in the yaml may be a scalar, an array of scalars,
 * or a named map (e.g. think: { default: "...", hard: "..." }).
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function collectStateFrames(value) {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.map((v) => String(v));
  }
  if (typeof value === "object") {
    return Object.values(/** @type {Record<string, unknown>} */ (value)).map(
      (v) => String(v),
    );
  }
  return [String(value)];
}

/**
 * Pick the canonical "primary" frame for a state. The bundled
 * ascii.yaml uses "default" as the conventional name for the
 * primary frame in named maps; when absent, fall back to the first
 * available frame.
 *
 * @param {string[]} frames
 * @param {unknown} raw
 * @returns {string}
 */
function pickPrimaryFrame(frames, raw) {
  if (frames.length === 0) return "";
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const named = /** @type {Record<string, unknown>} */ (raw);
    if (typeof named.default === "string") return named.default;
    const firstNamed = Object.values(named).find((v) => typeof v === "string");
    if (typeof firstNamed === "string") return firstNamed;
  }
  return frames[0];
}

/**
 * Load the bundled ASCII emote set through the maintained `yaml`
 * parser. Throws a clear error if the yaml is missing or if a
 * required state is absent.
 *
 * Required states: think, idle, talk, read, write, failure, compact.
 * All seven are required because the benchmark needs every one to
 * drive its reset/recovery paths.
 *
 * @returns {Promise<BundledFrames>}
 */
export async function loadBundledFrames() {
  let yamlText;
  try {
    yamlText = readFileSync(BUNDLED_ASCII_YAML, "utf8");
  } catch (err) {
    throw new Error(
      `failed to read bundled ASCII yaml at ${BUNDLED_ASCII_YAML}: ${err.message}`,
    );
  }

  let parsed;
  try {
    parsed = parseYaml(yamlText);
  } catch (err) {
    throw new Error(
      `failed to parse bundled ASCII yaml at ${BUNDLED_ASCII_YAML}: ${err.message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `bundled ASCII yaml at ${BUNDLED_ASCII_YAML} did not parse to a state map`,
    );
  }

  const map = /** @type {Record<string, unknown>} */ (parsed);

  const requiredStates = ["think", "idle", "talk", "read", "write", "failure", "compact"];
  /** @type {Record<string, string[]>} */
  const frames = {};
  for (const state of requiredStates) {
    frames[state] = collectStateFrames(map[state]);
    if (frames[state].length === 0) {
      throw new Error(
        `bundled ASCII emote set has no "${state}" frames at ${BUNDLED_ASCII_YAML}`,
      );
    }
  }

  const think = frames.think;
  const idle = frames.idle;
  const talk = frames.talk;
  const read = frames.read;
  const write = frames.write;
  const failure = frames.failure;
  const compact = frames.compact;
  const primaryThink = pickPrimaryFrame(think, map.think);

  return {
    think,
    idle,
    talk,
    read,
    write,
    failure,
    compact,
    primaryThink,
    sourceFile: "<REPO>/emotes/ascii/ascii.yaml",
    loadedFrom: "yaml package (scripts/lib/benchmark-frame-loader.mjs)",
  };
}
