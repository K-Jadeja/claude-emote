// scripts/lib/benchmark-cli.mjs
//
// Phase 9B benchmark CLI parser. Import-safe module with no runtime
// dependencies. Owns the documented defaults, the --quick shape, and
// every validation rule. Designed so a unit test can exercise parsing
// in isolation without booting a benchmark process.
//
// CLI surface:
//
//   npm run benchmark:latency                 → defaults
//   npm run benchmark:latency -- --quick      → QUICK_CONFIG
//   npm run benchmark:latency -- \
//     --runs=3 --samples=50 --warmup=10 \
//     --fail-open-samples=30 \
//     --output-dir=docs/benchmarks            → explicit config
//
// Invalid input throws CliError. Errors never silently clamp to a
// default — the spec mandates "do not silently clamp malformed
// values".

/** Default benchmark configuration. */
export const DEFAULT_CONFIG = Object.freeze({
  runs: 3,
  samples: 50,
  warmup: 10,
  failOpenSamples: 30,
  outputDir: "docs/benchmarks",
});

/** --quick mode configuration. */
export const QUICK_CONFIG = Object.freeze({
  runs: 1,
  samples: 3,
  warmup: 1,
  failOpenSamples: 3,
  outputDir: "docs/benchmarks",
});

/** Numeric CLI flags that --quick must NOT be combined with. */
const QUICK_INCOMPATIBLE_NUMERIC = [
  "runs",
  "samples",
  "warmup",
  "fail-open-samples",
];

/** Every supported --flag name. Anything else is rejected. */
const KNOWN_FLAGS = new Set([
  "runs",
  "samples",
  "warmup",
  "fail-open-samples",
  "output-dir",
]);

/** Distinct error class so callers can detect parse failures. */
export class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliError";
  }
}

/**
 * Parse a single --name=value token. The token's prefix must start
 * with two dashes. The value is everything after the first equals
 * sign. Returns the { name, value } pair or throws.
 *
 * @param {string} token
 * @returns {{ name: string, value: string }}
 */
export function tokenize(token) {
  if (typeof token !== "string" || !token.startsWith("--")) {
    throw new CliError(`unknown flag "${token}"`);
  }
  const eq = token.indexOf("=");
  if (eq === -1) {
    throw new CliError(
      `flag ${token} must be of the form --name=value (no equals sign found)`,
    );
  }
  return {
    name: token.slice(2, eq),
    value: token.slice(eq + 1),
  };
}

/**
 * Verify the value string represents a non-negative integer. Returns
 * the parsed integer. Throws CliError on malformed input.
 *
 * @param {string} raw
 * @param {string} flagName
 * @param {number} min  inclusive lower bound
 */
export function parseInteger(raw, flagName, min) {
  if (raw === "" || raw === null || raw === undefined) {
    throw new CliError(`--${flagName} requires a value`);
  }
  if (!/^-?\d+$/.test(String(raw))) {
    throw new CliError(
      `--${flagName} must be an integer (got "${raw}")`,
    );
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new CliError(`--${flagName} must be an integer (got "${raw}")`);
  }
  if (n < min) {
    throw new CliError(
      `--${flagName} must be >= ${min} (got ${n})`,
    );
  }
  return n;
}

/**
 * Parse an argv array. The argv slice must NOT contain `node` or the
 * script name — those should already be stripped before this call.
 *
 * @param {string[]} argv
 * @returns {{
 *   config: object,
 *   quick: boolean,
 *   noWrite: boolean,
 *   flagOverrides: string[]
 * }}
 */
export function parseArgs(argv) {
  if (!Array.isArray(argv)) {
    throw new CliError("argv must be an array");
  }
  let quick = false;
  let noWrite = false;
  /** @type {Record<string, string>} */
  const rawOverrides = {};
  /** @type {string[]} */
  const flagOverrides = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--quick") {
      if (quick) {
        throw new CliError("--quick supplied more than once");
      }
      quick = true;
      continue;
    }
    if (token === "--no-write") {
      if (noWrite) {
        throw new CliError("--no-write supplied more than once");
      }
      noWrite = true;
      continue;
    }
    const { name, value } = tokenize(token);
    if (!KNOWN_FLAGS.has(name)) {
      throw new CliError(`unknown flag "--${name}"`);
    }
    if (name in rawOverrides) {
      throw new CliError(
        `--${name} supplied more than once (conflicting values)`,
      );
    }
    rawOverrides[name] = value;
    flagOverrides.push(name);
  }

  // Reject --quick combined with explicit numeric overrides — the
  // combination is ambiguous about which the caller intended.
  if (quick) {
    for (const flag of QUICK_INCOMPATIBLE_NUMERIC) {
      if (flag in rawOverrides) {
        throw new CliError(
          `--quick cannot be combined with --${flag}=${rawOverrides[flag]}`,
        );
      }
    }
  }

  // Start from the appropriate base config.
  const config = quick ? { ...QUICK_CONFIG } : { ...DEFAULT_CONFIG };

  if ("runs" in rawOverrides) {
    config.runs = parseInteger(rawOverrides["runs"], "runs", 1);
  }
  if ("samples" in rawOverrides) {
    config.samples = parseInteger(rawOverrides["samples"], "samples", 1);
  }
  if ("warmup" in rawOverrides) {
    config.warmup = parseInteger(rawOverrides["warmup"], "warmup", 0);
  }
  if ("fail-open-samples" in rawOverrides) {
    config.failOpenSamples = parseInteger(
      rawOverrides["fail-open-samples"],
      "fail-open-samples",
      1,
    );
  }
  if ("output-dir" in rawOverrides) {
    const v = rawOverrides["output-dir"];
    if (!v || typeof v !== "string") {
      throw new CliError("--output-dir requires a non-empty path");
    }
    config.outputDir = v;
  }

  return { config, quick, noWrite, flagOverrides };
}