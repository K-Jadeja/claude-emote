/**
 * tests/unit/benchmark-stats.test.ts
 *
 * Unit tests for the Phase 9B benchmark-statistics helper. No timing
 * assertions; all expectations are pure arithmetic.
 */

import { describe, it, expect } from "vitest";
import {
  summarize,
  nearestRank,
  toDisplayMs,
  displaySummary,
  parsePositiveInt,
  parseNonNegativeInt,
  validateBenchmarkResult,
  sanitizePath,
  sanitizeRecordDeep,
  forbiddenSubstrings,
  findForbiddenSubstrings,
  firstInvalidIndex,
  assertFiniteNonNegative,
} from "../../scripts/lib/benchmark-stats.mjs";

describe("nearestRank", () => {
  it("returns the smallest value covering ceil(percentile*n) values", () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(nearestRank(s, 0.5)).toBe(5); // rank = ceil(5) = 5
    expect(nearestRank(s, 0.95)).toBe(10); // rank = ceil(9.5) = 10
    expect(nearestRank(s, 0.99)).toBe(10); // rank = ceil(9.9) = 10
    expect(nearestRank(s, 0)).toBe(1); // rank = max(1, ceil(0)) = 1
    expect(nearestRank(s, 1)).toBe(10); // rank = ceil(10) = 10
  });

  it("handles a single-element array for every quantile", () => {
    const s = [42];
    expect(nearestRank(s, 0.5)).toBe(42);
    expect(nearestRank(s, 0.95)).toBe(42);
    expect(nearestRank(s, 1)).toBe(42);
  });

  it("rejects empty input, NaN, and out-of-range percentiles", () => {
    expect(() => nearestRank([], 0.5)).toThrow(/non-empty/);
    expect(() => nearestRank([1, 2, 3], Number.NaN)).toThrow(/finite/);
    expect(() => nearestRank([1, 2, 3], -0.1)).toThrow(/\[0, 1\]/);
    expect(() => nearestRank([1, 2, 3], 1.01)).toThrow(/\[0, 1\]/);
  });
});

describe("summarize", () => {
  it("returns count, min, max, mean, p50, p95, p99, stdev", () => {
    const out = summarize([10, 20, 30, 40, 50]);
    expect(out.count).toBe(5);
    expect(out.min).toBe(10);
    expect(out.max).toBe(50);
    expect(out.mean).toBe(30);
    // Even sample count: median is the lower middle under nearest-rank.
    // rank = ceil(0.5 * 5) = 3 → sorted[2] = 30.
    expect(out.p50).toBe(30);
    expect(out.p95).toBe(50);
    expect(out.p99).toBe(50);
  });

  it("handles an odd sample median correctly", () => {
    const out = summarize([1, 2, 3]);
    // rank = ceil(0.5 * 3) = 2 → sorted[1] = 2.
    expect(out.p50).toBe(2);
    expect(out.min).toBe(1);
    expect(out.max).toBe(3);
    expect(out.mean).toBeCloseTo(2, 12);
  });

  it("handles a one-sample distribution with stdev = 0", () => {
    const out = summarize([42]);
    expect(out.count).toBe(1);
    expect(out.min).toBe(42);
    expect(out.max).toBe(42);
    expect(out.mean).toBe(42);
    expect(out.p50).toBe(42);
    expect(out.p95).toBe(42);
    expect(out.p99).toBe(42);
    expect(out.stdev).toBe(0);
  });

  it("computes sample standard deviation with n-1 divisor", () => {
    // values: 2,4,4,4,5,5,7,9 — well-known sample stdev = 2.13808993...
    const out = summarize([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(out.stdev).toBeCloseTo(2.13808993, 7);
  });

  it("rejects an empty array", () => {
    expect(() => summarize([])).toThrow(/non-empty/);
  });

  it("rejects non-finite samples", () => {
    expect(() => summarize([1, Number.NaN, 3])).toThrow(/finite/);
    expect(() => summarize([Number.POSITIVE_INFINITY, 2])).toThrow(/finite/);
  });

  it("rejects negative samples", () => {
    expect(() => summarize([1, -1, 3])).toThrow(/non-negative/);
  });

  it("does not mutate the input array (even when unsorted)", () => {
    const input = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5];
    const before = [...input];
    summarize(input);
    expect(input).toEqual(before);
  });
});

describe("firstInvalidIndex / assertFiniteNonNegative", () => {
  it("firstInvalidIndex returns -1 for valid arrays", () => {
    expect(firstInvalidIndex([0, 1, 2])).toBe(-1);
  });
  it("firstInvalidIndex points at the first bad value", () => {
    expect(firstInvalidIndex([0, -1, 2])).toBe(1);
    expect(firstInvalidIndex([0, Number.NaN, 2])).toBe(1);
    expect(firstInvalidIndex([0, "1" as unknown as number, 2])).toBe(1);
  });
  it("assertFiniteNonNegative throws on non-array", () => {
    // @ts-expect-error invalid input for runtime check
    expect(() => assertFiniteNonNegative(null)).toThrow(/array/);
  });
});

describe("toDisplayMs / displaySummary", () => {
  it("rounds milliseconds to two decimal places", () => {
    expect(toDisplayMs(1.234567)).toBe(1.23);
    expect(toDisplayMs(0)).toBe(0);
    expect(toDisplayMs(0.005)).toBe(0.01);
    expect(toDisplayMs(123.456789)).toBe(123.46);
  });
  it("preserves non-finite numbers verbatim", () => {
    expect(toDisplayMs(Number.NaN)).toBeNaN();
  });
  it("displaySummary rounds every field", () => {
    const out = displaySummary({
      count: 5,
      min: 1.2345,
      max: 10.9876,
      mean: 6.1111,
      p50: 5.5555,
      p95: 9.9999,
      p99: 10.5555,
      stdev: 3.4444,
    });
    expect(out.min).toBe(1.23);
    expect(out.max).toBe(10.99);
    expect(out.mean).toBe(6.11);
    expect(out.p50).toBe(5.56);
    expect(out.p95).toBe(10);
    expect(out.p99).toBe(10.56);
    expect(out.stdev).toBe(3.44);
    expect(out.count).toBe(5);
  });
});

describe("parsePositiveInt / parseNonNegativeInt", () => {
  it("parses valid positive integers", () => {
    expect(parsePositiveInt("1", "samples")).toBe(1);
    expect(parsePositiveInt("120", "samples")).toBe(120);
  });
  it("rejects missing, non-numeric, and fractional input", () => {
    expect(() => parsePositiveInt(undefined, "samples")).toThrow(/requires/);
    expect(() => parsePositiveInt("", "samples")).toThrow(/requires/);
    expect(() => parsePositiveInt("foo", "samples")).toThrow(/integer/);
    expect(() => parsePositiveInt("1.5", "samples")).toThrow(/integer/);
    expect(() => parsePositiveInt("-3", "samples")).toThrow(/integer/);
    expect(() => parsePositiveInt("0", "samples")).toThrow(/>= 1/);
    expect(parsePositiveInt("0", "samples", 0)).toBe(0);
  });
  it("parseNonNegativeInt accepts zero", () => {
    expect(parseNonNegativeInt("0", "warmup")).toBe(0);
    expect(parseNonNegativeInt("10", "warmup")).toBe(10);
    expect(() => parseNonNegativeInt("-1", "warmup")).toThrow(/>= 0|non-negative integer/);
  });
});

describe("validateBenchmarkResult", () => {
  const fixture = {
    schemaVersion: 1,
    metadata: {},
    configuration: {},
    runs: [{}],
    aggregate: {},
    stateSweep: [],
    thresholds: {},
  };

  it("accepts the canonical schema", () => {
    expect(validateBenchmarkResult(fixture)).toBe(true);
  });
  it("rejects a non-object record", () => {
    expect(() => validateBenchmarkResult(null)).toThrow(/object/);
    expect(() => validateBenchmarkResult("bad")).toThrow(/object/);
  });
  it("rejects a different schemaVersion", () => {
    expect(() =>
      validateBenchmarkResult({ ...fixture, schemaVersion: 2 }),
    ).toThrow(/schemaVersion/);
  });
  it("rejects missing top-level fields", () => {
    const noMeta = { ...fixture, metadata: undefined };
    expect(() => validateBenchmarkResult(noMeta)).toThrow(/metadata/);
    const noRuns = { ...fixture, runs: "bad" };
    expect(() => validateBenchmarkResult(noRuns)).toThrow(/runs/);
    const noAgg = { ...fixture, aggregate: undefined };
    expect(() => validateBenchmarkResult(noAgg)).toThrow(/aggregate/);
    const noSweep = { ...fixture, stateSweep: "bad" };
    expect(() => validateBenchmarkResult(noSweep)).toThrow(/stateSweep/);
    const noThr = { ...fixture, thresholds: undefined };
    expect(() => validateBenchmarkResult(noThr)).toThrow(/thresholds/);
  });
  it("rejects a run that is not an object", () => {
    expect(() =>
      validateBenchmarkResult({ ...fixture, runs: [null] }),
    ).toThrow(/each run/);
  });
});

describe("sanitizePath", () => {
  it("redacts repo and temp paths", () => {
    const repo = "D:\\Workspace\\Github-Projects\\claudecodeavatar";
    const tmp = "C:\\Users\\krish\\AppData\\Local\\Temp\\abc";
    const out = sanitizePath(`${repo}\\dist\\foo.js and ${tmp}\\bar`, repo, tmp);
    expect(out).toContain("<REPO>");
    expect(out).toContain("<TMP>");
    expect(out).not.toContain("claudecodeavatar");
    expect(out).not.toContain("krish");
  });
  it("redacts USERPROFILE-shaped paths even with no repo/tmp provided", () => {
    const out = sanitizePath(
      "C:\\Users\\krishna\\AppData\\Local\\Temp\\x",
      "",
      "",
    );
    expect(out).toContain("<USERHOME>");
    expect(out).not.toContain("krishna");
  });
  it("returns non-strings unchanged", () => {
    // @ts-expect-error runtime check
    expect(sanitizePath(undefined, "", "")).toBeUndefined();
    // @ts-expect-error runtime check
    expect(sanitizePath(42, "", "")).toBe(42);
  });
});

describe("sanitizeRecordDeep", () => {
  it("redacts repo and tmp paths inside nested objects", () => {
    const repo = "D:\\Workspace\\Github-Projects\\claudecodeavatar";
    const tmp = "C:\\Users\\krish\\AppData\\Local\\Temp\\phase9b";
    const record = {
      metadata: {
        repoRoot: repo,
        path: `${repo}\\dist\\foo.js`,
        tmpPath: `${tmp}\\x`,
      },
      runs: [
        { raw: { x: `${repo}\\file`, y: [`${tmp}\\z`] } },
      ],
    };
    const out = sanitizeRecordDeep(record, { repoRoot: repo, tmpDir: tmp });
    expect(JSON.stringify(out)).not.toContain(repo);
    expect(JSON.stringify(out)).not.toContain(tmp);
    expect(JSON.stringify(out)).toContain("<REPO>");
    expect(JSON.stringify(out)).toContain("<TEMP>");
  });
  it("redacts Windows users/<name> prefixes even without an explicit home", () => {
    const record = {
      p: "C:\\Users\\alice\\Documents\\thing",
      q: "/Users/bob/Projects/x",
    };
    const out = sanitizeRecordDeep(record);
    expect(JSON.stringify(out)).toContain("<USERHOME>");
    expect(JSON.stringify(out)).not.toContain("alice");
    expect(JSON.stringify(out)).not.toContain("bob");
  });
  it("redacts hostname and username when supplied", () => {
    const record = { host: "MY-LAPTOP", note: "alice ran this on MY-LAPTOP" };
    const out = sanitizeRecordDeep(record, {
      username: "alice",
      hostname: "MY-LAPTOP",
    });
    expect(JSON.stringify(out)).toContain("<HOST>");
    expect(JSON.stringify(out)).toContain("<USER>");
    expect(JSON.stringify(out)).not.toContain("MY-LAPTOP");
    expect(JSON.stringify(out)).not.toContain("alice");
  });
  it("does not mutate the input record", () => {
    const record = { a: "C:\\Users\\x\\y" };
    const copy = JSON.stringify(record);
    sanitizeRecordDeep(record);
    expect(JSON.stringify(record)).toBe(copy);
  });
  it("leaves numbers, booleans, and null unchanged", () => {
    const record = { n: 42, b: true, z: null };
    expect(sanitizeRecordDeep(record)).toEqual({ n: 42, b: true, z: null });
  });
});

describe("forbiddenSubstrings / findForbiddenSubstrings", () => {
  it("returns the union of personal tokens the caller supplies", () => {
    const list = forbiddenSubstrings({
      repoRoot: "D:/repo",
      tmpDir: "C:/tmp/x",
      username: "alice",
      hostname: "MY-LAPTOP",
    });
    expect(list).toContain("D:/repo");
    expect(list).toContain("C:/tmp/x");
    expect(list).toContain("alice");
    expect(list).toContain("MY-LAPTOP");
    expect(list).toContain("C:\\Users\\");
  });
  it("finds forbidden substrings nested anywhere", () => {
    const record = {
      metadata: { repo: "D:/repo" },
      runs: [{ raw: { path: "D:/repo/file" } }],
    };
    const found = findForbiddenSubstrings(record, ["D:/repo"]);
    expect(found).toContain("D:/repo");
  });
  it("returns empty when nothing leaks", () => {
    const found = findForbiddenSubstrings(
      { a: 1, b: ["x", "y"] },
      ["D:/repo"],
    );
    expect(found).toEqual([]);
  });
});
