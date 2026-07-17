/**
 * tests/unit/benchmark-cli.test.ts
 *
 * Focused tests for the benchmark CLI parser. No process spawning,
 * no timing, no tempdirs. Exercises every documented default,
 * every --quick interaction, and every malformed-input case.
 */

import { describe, it, expect } from "vitest";
import {
  parseArgs,
  tokenize,
  parseInteger,
  CliError,
  DEFAULT_CONFIG,
  QUICK_CONFIG,
} from "../../scripts/lib/benchmark-cli.mjs";

describe("tokenize", () => {
  it("splits --name=value into name and value", () => {
    expect(tokenize("--runs=3")).toEqual({ name: "runs", value: "3" });
    expect(tokenize("--output-dir=docs/x")).toEqual({
      name: "output-dir",
      value: "docs/x",
    });
  });
  it("preserves empty values verbatim", () => {
    expect(tokenize("--foo=")).toEqual({ name: "foo", value: "" });
  });
  it("rejects tokens without -- prefix", () => {
    expect(() => tokenize("runs=3")).toThrow(CliError);
  });
  it("rejects tokens without = sign", () => {
    expect(() => tokenize("--runs")).toThrow(CliError);
    expect(() => tokenize("--runs 3")).toThrow(CliError);
  });
});

describe("parseInteger", () => {
  it("accepts valid positive integers", () => {
    expect(parseInteger("1", "samples", 1)).toBe(1);
    expect(parseInteger("50", "samples", 1)).toBe(50);
  });
  it("accepts 0 when min is 0", () => {
    expect(parseInteger("0", "warmup", 0)).toBe(0);
  });
  it("rejects below-minimum", () => {
    expect(() => parseInteger("0", "samples", 1)).toThrow(/>= 1/);
    expect(() => parseInteger("-1", "warmup", 0)).toThrow(/>= 0/);
  });
  it("rejects NaN, floats, signs, empty", () => {
    expect(() => parseInteger("foo", "samples", 1)).toThrow(/integer/);
    expect(() => parseInteger("1.5", "samples", 1)).toThrow(/integer/);
    expect(() => parseInteger("+1", "samples", 1)).toThrow(/integer/);
    expect(() => parseInteger("", "samples", 1)).toThrow(/requires/);
    expect(() => parseInteger(undefined as unknown as string, "samples", 1)).toThrow(/requires/);
  });
});

describe("parseArgs defaults", () => {
  it("uses DEFAULT_CONFIG when no arguments are supplied", () => {
    const out = parseArgs([]);
    expect(out.quick).toBe(false);
    expect(out.noWrite).toBe(false);
    expect(out.config).toEqual(DEFAULT_CONFIG);
  });
  it("DEFAULT_CONFIG has the documented values", () => {
    expect(DEFAULT_CONFIG).toEqual({
      runs: 3,
      samples: 50,
      warmup: 10,
      failOpenSamples: 30,
      outputDir: "docs/benchmarks",
    });
  });
  it("DEFAULT_CONFIG is frozen", () => {
    expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
  });
  it("QUICK_CONFIG has the documented values", () => {
    expect(QUICK_CONFIG).toEqual({
      runs: 1,
      samples: 3,
      warmup: 1,
      failOpenSamples: 3,
      outputDir: "docs/benchmarks",
    });
  });
});

describe("parseArgs --quick", () => {
  it("uses QUICK_CONFIG when --quick is supplied alone", () => {
    const out = parseArgs(["--quick"]);
    expect(out.quick).toBe(true);
    expect(out.config).toEqual(QUICK_CONFIG);
  });
  it("--quick combined with --no-write is allowed", () => {
    const out = parseArgs(["--quick", "--no-write"]);
    expect(out.quick).toBe(true);
    expect(out.noWrite).toBe(true);
    expect(out.config).toEqual(QUICK_CONFIG);
  });
  it("--quick combined with --output-dir is allowed", () => {
    const out = parseArgs(["--quick", "--output-dir=foo/bar"]);
    expect(out.quick).toBe(true);
    expect(out.config.outputDir).toBe("foo/bar");
    expect(out.config.runs).toBe(1);
    expect(out.config.samples).toBe(3);
  });
  it("rejects --quick combined with --runs", () => {
    expect(() => parseArgs(["--quick", "--runs=3"])).toThrow(
      /--quick cannot be combined with --runs/,
    );
  });
  it("rejects --quick combined with --samples", () => {
    expect(() => parseArgs(["--quick", "--samples=50"])).toThrow(
      /--quick cannot be combined with --samples/,
    );
  });
  it("rejects --quick combined with --warmup", () => {
    expect(() => parseArgs(["--quick", "--warmup=10"])).toThrow(
      /--quick cannot be combined with --warmup/,
    );
  });
  it("rejects --quick combined with --fail-open-samples", () => {
    expect(() => parseArgs(["--quick", "--fail-open-samples=30"])).toThrow(
      /--quick cannot be combined with --fail-open-samples/,
    );
  });
  it("rejects --quick supplied twice", () => {
    expect(() => parseArgs(["--quick", "--quick"])).toThrow(
      /--quick supplied more than once/,
    );
  });
});

describe("parseArgs explicit overrides", () => {
  it("preserves explicit values exactly", () => {
    const out = parseArgs([
      "--runs=3",
      "--samples=50",
      "--warmup=10",
      "--fail-open-samples=30",
      "--output-dir=docs/benchmarks",
    ]);
    expect(out.config).toEqual({
      runs: 3,
      samples: 50,
      warmup: 10,
      failOpenSamples: 30,
      outputDir: "docs/benchmarks",
    });
    expect(out.quick).toBe(false);
  });
  it("allows only --warmup override (others default)", () => {
    const out = parseArgs(["--warmup=0"]);
    expect(out.config.runs).toBe(3);
    expect(out.config.samples).toBe(50);
    expect(out.config.warmup).toBe(0);
    expect(out.config.failOpenSamples).toBe(30);
  });
});

describe("parseArgs invalid input", () => {
  it("rejects --runs=0", () => {
    expect(() => parseArgs(["--runs=0"])).toThrow(/--runs must be >= 1/);
  });
  it("rejects --runs=-3", () => {
    expect(() => parseArgs(["--runs=-3"])).toThrow(/--runs must be >= 1/);
  });
  it("rejects --runs=foo", () => {
    expect(() => parseArgs(["--runs=foo"])).toThrow(/--runs must be an integer/);
  });
  it("rejects --runs=1.5", () => {
    expect(() => parseArgs(["--runs=1.5"])).toThrow(/--runs must be an integer/);
  });
  it("rejects --runs (no equals sign)", () => {
    expect(() => parseArgs(["--runs"])).toThrow(/must be of the form/);
  });
  it("rejects --warmup=-1", () => {
    expect(() => parseArgs(["--warmup=-1"])).toThrow(/--warmup must be >= 0/);
  });
  it("rejects --fail-open-samples=NaN", () => {
    expect(() => parseArgs(["--fail-open-samples=NaN"])).toThrow(
      /--fail-open-samples must be an integer/,
    );
  });
  it("rejects unknown flag", () => {
    expect(() => parseArgs(["--frobnicate=1"])).toThrow(/unknown flag/);
  });
  it("rejects duplicate --runs", () => {
    expect(() => parseArgs(["--runs=1", "--runs=2"])).toThrow(
      /--runs supplied more than once/,
    );
  });
  it("rejects empty output-dir value", () => {
    expect(() => parseArgs(["--output-dir="])).toThrow(/--output-dir/);
  });
});

describe("parseArgs order independence", () => {
  it("accepts --no-write in any position", () => {
    expect(parseArgs(["--no-write", "--runs=3"]).noWrite).toBe(true);
    expect(parseArgs(["--runs=3", "--no-write"]).noWrite).toBe(true);
  });
  it("records every override flag", () => {
    const out = parseArgs(["--runs=3", "--output-dir=foo"]);
    expect(out.flagOverrides).toEqual(["runs", "output-dir"]);
  });
});