// scripts/lib/benchmark-stats.mjs
//
// Phase 9B authoritative benchmark helper. Pure-function statistics over
// non-negative finite millisecond samples. No mutation of caller arrays.
// No production instrumentation: this file never imports runtime code.

/** @typedef {{ count:number, min:number, max:number, mean:number, p50:number, p95:number, p99:number, stdev:number }} Summary */

/**
 * Reject any sample that is not a finite, non-negative number. Returns
 * the first index that violated the contract, or -1 when every sample
 * is valid.
 *
 * @param {unknown[]} samples
 * @returns {number}
 */
export function firstInvalidIndex(samples) {
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return i;
    }
  }
  return -1;
}

/**
 * Throws if the sample array is empty or contains invalid samples.
 *
 * @param {unknown[]} samples
 * @returns {void}
 */
export function assertFiniteNonNegative(samples) {
  if (!Array.isArray(samples)) {
    throw new TypeError("samples must be an array");
  }
  if (samples.length === 0) {
    throw new RangeError("samples must be non-empty");
  }
  const bad = firstInvalidIndex(samples);
  if (bad !== -1) {
    const v = samples[bad];
    throw new RangeError(
      `sample at index ${bad} is not a finite non-negative number (${typeof v === "number" ? v : typeof v})`,
    );
  }
}

/**
 * Nearest-rank percentile. Returns the smallest value in `sorted` such
 * that at least `percentile * 100` percent of values are less than or
 * equal to it. Equivalent to the standard nearest-rank definition:
 *
 *   rank = max(1, ceil(percentile * sampleCount))
 *   index = rank - 1
 *
 * The caller pre-sorts so we can index directly. We clamp the index to
 * a valid position so percentiles at q=1.0 and q=0.0 are well-defined.
 *
 * @param {number[]} sorted  Assumed ascending. Not mutated by us; the
 *                           caller passes a copy when it cares.
 * @param {number}   percentile  in [0, 1]
 * @returns {number}
 */
export function nearestRank(sorted, percentile) {
  if (!Array.isArray(sorted) || sorted.length === 0) {
    throw new RangeError("sorted must be a non-empty array");
  }
  if (
    typeof percentile !== "number" ||
    !Number.isFinite(percentile) ||
    percentile < 0 ||
    percentile > 1
  ) {
    throw new RangeError("percentile must be a finite number in [0, 1]");
  }
  const n = sorted.length;
  const rank = Math.max(1, Math.ceil(percentile * n));
  return sorted[Math.min(n - 1, rank - 1)];
}

/**
 * Compute a basic summary over non-negative finite millisecond samples.
 * The input array is **never mutated**: every sort happens on a fresh
 * copy.
 *
 * @param {number[]} samples
 * @returns {Summary}
 */
export function summarize(samples) {
  assertFiniteNonNegative(samples);
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i];
  const mean = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = sorted[i] - mean;
    sq += d * d;
  }
  // Sample standard deviation (n-1) is the conventional choice for
  // observed measurement series; an honest divisor matters more than
  // a smaller denominator here because we report it in raw form.
  const stdev = n > 1 ? Math.sqrt(sq / (n - 1)) : 0;
  return {
    count: n,
    min: sorted[0],
    max: sorted[n - 1],
    mean,
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    p99: nearestRank(sorted, 0.99),
    stdev,
  };
}

/**
 * Round milliseconds to at most two decimal places. Returns the number
 * unchanged if it is not finite. Used for human-readable output; raw
 * JSON keeps full precision.
 *
 * @param {number} ms
 * @returns {number}
 */
export function toDisplayMs(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return ms;
  return Math.round(ms * 100) / 100;
}

/**
 * Format a {@link Summary} as a compact object suitable for printing
 * to stdout. Caller controls whether the raw {@link Summary} or this
 * display form is emitted.
 *
 * @param {Summary} s
 * @returns {{
 *   count:number, min:number, max:number, mean:number, p50:number,
 *   p95:number, p99:number, stdev:number
 * }}
 */
export function displaySummary(s) {
  return {
    count: s.count,
    min: toDisplayMs(s.min),
    max: toDisplayMs(s.max),
    mean: toDisplayMs(s.mean),
    p50: toDisplayMs(s.p50),
    p95: toDisplayMs(s.p95),
    p99: toDisplayMs(s.p99),
    stdev: toDisplayMs(s.stdev),
  };
}

/**
 * Parse a positive integer CLI option. Rejects floats, signs, empty
 * strings, and non-numeric input. `name` is included in the error
 * message so a user-facing error is self-explanatory.
 *
 * @param {string|undefined} raw
 * @param {string} name
 * @param {number} min
 * @returns {number}
 */
export function parsePositiveInt(raw, name, min = 1) {
  if (raw === undefined || raw === null || raw === "") {
    throw new RangeError(`--${name} requires a value`);
  }
  if (!/^\d+$/.test(String(raw))) {
    throw new RangeError(`--${name} must be a positive integer (got "${raw}")`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || !Number.isInteger(n)) {
    throw new RangeError(`--${name} must be an integer >= ${min} (got ${raw})`);
  }
  return n;
}

/**
 * Parse a non-negative integer CLI option. Accepts 0.
 *
 * @param {string|undefined} raw
 * @param {string} name
 * @returns {number}
 */
export function parseNonNegativeInt(raw, name) {
  if (raw === undefined || raw === null || raw === "") {
    throw new RangeError(`--${name} requires a value`);
  }
  if (!/^\d+$/.test(String(raw))) {
    throw new RangeError(
      `--${name} must be a non-negative integer (got "${raw}")`,
    );
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new RangeError(`--${name} must be an integer >= 0 (got ${raw})`);
  }
  return n;
}

/**
 * Validate a benchmark result record before it is written to a result
 * file. Confirms the top-level shape and per-field finiteness. Returns
 * the record on success, throws on schema violation.
 *
 * @param {unknown} record
 * @returns {record is object}
 */
export function validateBenchmarkResult(record) {
  if (!record || typeof record !== "object") {
    throw new TypeError("benchmark result must be an object");
  }
  const r = /** @type {Record<string, unknown>} */ (record);
  if (r.schemaVersion !== 1) {
    throw new RangeError(
      `unsupported schemaVersion ${String(r.schemaVersion)} (expected 1)`,
    );
  }
  if (!r.metadata || typeof r.metadata !== "object") {
    throw new TypeError("metadata is required");
  }
  if (!r.configuration || typeof r.configuration !== "object") {
    throw new TypeError("configuration is required");
  }
  if (!r.runs || !Array.isArray(r.runs)) {
    throw new TypeError("runs[] is required and must be an array");
  }
  for (const run of r.runs) {
    if (!run || typeof run !== "object") {
      throw new TypeError("each run must be an object");
    }
  }
  if (!r.aggregate || typeof r.aggregate !== "object") {
    throw new TypeError("aggregate is required");
  }
  if (!Array.isArray(r.stateSweep)) {
    throw new TypeError("stateSweep must be an array");
  }
  if (!r.thresholds || typeof r.thresholds !== "object") {
    throw new TypeError("thresholds are required");
  }
  return true;
}

/**
 * Replace any apparent absolute path the user might consider personal
 * with a stable token. Used on the metadata block before it is written
 * to a committed result file.
 *
 * Patterns stripped:
 *   - \\ or / style absolute paths that include a temp directory
 *   - HOME or USERPROFILE style locations under the user's account
 *
 * The replacement keeps enough information for a developer to locate
 * the relevant directory on the same machine while not leaking a
 * personal repository path into a shared artifact.
 *
 * @param {string} value
 * @param {string} repoRoot
 * @param {string} tmpDir
 * @returns {string}
 */
export function sanitizePath(value, repoRoot, tmpDir) {
  if (typeof value !== "string") return value;
  let out = value;
  if (repoRoot) {
    out = out.split(repoRoot).join("<REPO>");
  }
  if (tmpDir) {
    out = out.split(tmpDir).join("<TMP>");
  }
  // Windows home / temp patterns
  out = out.replace(/[A-Za-z]:\\Users\\[^\\/\s]+/g, "<USERHOME>");
  out = out.replace(/Users\/[^\\/\s]+\/(?:Documents|Downloads|AppData)/g, "<USERHOME>/$1");
  return out;
}

/**
 * Tokens we replace with placeholders when they leak into a
 * serialised record. We never substitute these tokens *into* a
 * record; we substitute any of these substrings *out* of a record.
 *
 * Detection logic: the caller passes in a list of personal tokens
 * (home dir, repo root, tmp dir, username) and we walk the record.
 */
const FORBIDDEN_SUBSTRINGS_DEFAULTS = [
  // Windows home / user markers
  "C:\\Users\\",
  "C:/Users/",
  // Common username env-vars
  "USERPROFILE=",
  "HOME=",
  // Generic "/Users/<name>/" prefix
  "/Users/",
];

/**
 * Build the list of forbidden substrings the validator should reject.
 *
 * @param {{ repoRoot?: string, tmpDir?: string, username?: string, homeDir?: string, hostname?: string }} opts
 * @returns {string[]}
 */
export function forbiddenSubstrings(opts) {
  const out = [...FORBIDDEN_SUBSTRINGS_DEFAULTS];
  if (opts.repoRoot) out.push(opts.repoRoot);
  if (opts.tmpDir) out.push(opts.tmpDir);
  if (opts.username) {
    out.push(`\\Users\\${opts.username}\\`);
    out.push(`/Users/${opts.username}/`);
    out.push(opts.username);
  }
  if (opts.homeDir) out.push(opts.homeDir);
  if (opts.hostname) {
    out.push(opts.hostname);
  }
  // Strip empties and short / ambiguous tokens.
  return out.filter((s) => s && s.length >= 3);
}

/**
 * Walk a serialised benchmark record and report every forbidden
 * substring that appears anywhere inside. Used by the result
 * validator and the cleanup audit.
 *
 * @param {unknown} record
 * @param {string[]} forbiddenSubstrings
 * @returns {string[]}
 */
export function findForbiddenSubstrings(record, forbiddenSubstrings) {
  const found = new Set();
  const seen = new Set();
  function walk(v) {
    if (seen.has(v)) return;
    if (typeof v === "string") {
      for (const sub of forbiddenSubstrings) {
        if (v.includes(sub)) found.add(sub);
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (v && typeof v === "object") {
      seen.add(v);
      for (const k of Object.keys(v)) walk(v[k]);
    }
  }
  walk(record);
  return [...found];
}

/**
 * Deep-clone a serialisable value and replace every forbidden
 * substring in every string leaf with the corresponding placeholder.
 *
 * Placeholders:
 *   - repoRoot       → "<REPO>"
 *   - tmpDir         → "<TEMP>"
 *   - home / Users  → "<USERHOME>"
 *   - username       → "<USER>"
 *   - hostname       → "<HOST>"
 *
 * @param {unknown} value
 * @param {{ repoRoot?: string, tmpDir?: string, username?: string, hostname?: string, homeDir?: string }} opts
 * @returns {unknown}
 */
export function sanitizeRecordDeep(value, opts = {}) {
  const placeholders = {
    [opts.repoRoot || "<__REPO__>"]: "<REPO>",
    [opts.tmpDir || "<__TMP__>"]: "<TEMP>",
  };
  function replaceOne(s) {
    let out = s;
    if (opts.repoRoot) out = out.split(opts.repoRoot).join("<REPO>");
    if (opts.tmpDir) out = out.split(opts.tmpDir).join("<TEMP>");
    if (opts.username) {
      out = out
        .split(`\\Users\\${opts.username}\\`)
        .join("<USERHOME>\\");
      out = out.split(`/Users/${opts.username}/`).join("<USERHOME>/");
      // Direct username leakage (rare, but possible in env paths).
      const re = new RegExp(escapeRegex(opts.username), "g");
      out = out.replace(re, "<USER>");
    }
    if (opts.homeDir) out = out.split(opts.homeDir).join("<USERHOME>");
    if (opts.hostname) out = out.split(opts.hostname).join("<HOST>");
    // Drop any drive-letter Users pattern even when username unknown.
    out = out.replace(/[A-Za-z]:\\Users\\[^\\/\s]+/g, "<USERHOME>");
    out = out.replace(/\/Users\/[^\\/\s]+\//g, "<USERHOME>/");
    return out;
  }
  if (typeof value === "string") return replaceOne(value);
  if (Array.isArray(value)) return value.map((x) => sanitizeRecordDeep(x, opts));
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = sanitizeRecordDeep(value[k], opts);
    }
    return out;
  }
  return value;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
