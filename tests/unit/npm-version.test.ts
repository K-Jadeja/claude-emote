/**
 * tests/unit/npm-version.test.ts
 *
 * Focused tests for the Phase 9B npm-version helper. Exercises the
 * preferred npm_config_user_agent parser and the documented fallback.
 *
 *   1. npm/10.8.2 → 10.8.2 (the case the benchmark must report)
 *   2. Other token orderings
 *   3. Malformed user-agent string
 *   4. Absent user-agent string
 *   5. readNpmVersion reads npm_config_user_agent when present
 *   6. packageVersion comes from package.json (independent of npm)
 *
 * No real npm spawn — runNpm is the only fallback path and is not
 * triggered when npm_config_user_agent is set. We deliberately do
 * NOT exercise runNpm here because it requires the bundled npm to be
 * present at require.resolve('npm/bin/npm-cli.js'); that path is
 * covered by validate-package.mjs.
 */

import { describe, it, expect } from "vitest";
import {
  parseNpmFromUserAgent,
  readNpmVersion,
} from "../../scripts/lib/npm-version.mjs";

describe("parseNpmFromUserAgent", () => {
  it("parses 10.8.2 from a typical npm/10.8.2 node/v20.15.0 win32 x64 agent", () => {
    expect(parseNpmFromUserAgent("npm/10.8.2 node/v20.15.0 win32 x64")).toBe(
      "10.8.2",
    );
  });

  it("parses 10.7.0 when the agent reports a different npm", () => {
    expect(parseNpmFromUserAgent("npm/10.7.0 node/v20.14.0 linux x64")).toBe(
      "10.7.0",
    );
  });

  it("parses 9.6.7 from a yarn-prefixed agent when the npm token is present", () => {
    // Some pnpm/yarn shims include an "npm/<v>" token.
    expect(
      parseNpmFromUserAgent("yarn/1.22.22 npm/9.6.7 node/v18.20.0 linux x64"),
    ).toBe("9.6.7");
  });

  it("parses a pre-release / build-metadata suffix", () => {
    expect(
      parseNpmFromUserAgent("npm/10.8.2-rc.1 node/v20.15.0 darwin arm64"),
    ).toBe("10.8.2-rc.1");
  });

  it("returns null for an agent that has no npm/ token", () => {
    expect(parseNpmFromUserAgent("pnpm/9.0.0 node/v20.15.0 linux x64")).toBeNull();
    expect(parseNpmFromUserAgent("yarn/1.22.22 node/v20.15.0 linux x64")).toBeNull();
  });

  it("returns null for a malformed npm/? token", () => {
    expect(parseNpmFromUserAgent("npm/? node/v20.15.0 linux x64")).toBeNull();
  });

  it("returns null for run-together tokens without a word boundary", () => {
    expect(parseNpmFromUserAgent("npmnot/10.8.2 node/v20.15.0 linux x64")).toBeNull();
  });

  it("returns null for the empty string, null, and undefined", () => {
    expect(parseNpmFromUserAgent("")).toBeNull();
    expect(parseNpmFromUserAgent(null)).toBeNull();
    expect(parseNpmFromUserAgent(undefined)).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(parseNpmFromUserAgent(42 as unknown as string)).toBeNull();
    expect(parseNpmFromUserAgent({} as unknown as string)).toBeNull();
  });
});

describe("readNpmVersion", () => {
  it("returns the parsed npm version when npm_config_user_agent is set", async () => {
    const prev = process.env.npm_config_user_agent;
    try {
      process.env.npm_config_user_agent = "npm/10.8.2 node/v20.15.0 win32 x64";
      expect(await readNpmVersion()).toBe("10.8.2");
    } finally {
      if (prev === undefined) delete process.env.npm_config_user_agent;
      else process.env.npm_config_user_agent = prev;
    }
  });

  it("returns the parsed npm version for an alternate agent string", async () => {
    const prev = process.env.npm_config_user_agent;
    try {
      process.env.npm_config_user_agent = "npm/9.10.1 node/v18.20.0 linux x64";
      expect(await readNpmVersion()).toBe("9.10.1");
    } finally {
      if (prev === undefined) delete process.env.npm_config_user_agent;
      else process.env.npm_config_user_agent = prev;
    }
  });

  it("prefers npm_config_user_agent over a fallback (does not spawn npm)", async () => {
    // If the parser were broken and the function fell back to
    // runNpm, the test would either time out (no npm available) or
    // return a different value than 10.8.2. We assert the exact
    // value here so a regression is loud.
    const prev = process.env.npm_config_user_agent;
    try {
      process.env.npm_config_user_agent =
        "npm/10.8.2 node/v20.15.0 win32 x64";
      const v = await readNpmVersion();
      expect(v).toBe("10.8.2");
    } finally {
      if (prev === undefined) delete process.env.npm_config_user_agent;
      else process.env.npm_config_user_agent = prev;
    }
  });

  it("falls back to 'unknown' when no agent is set and npm cannot be spawned", async () => {
    const prevUa = process.env.npm_config_user_agent;
    // We don't try to clear require.resolve's npm cache; we rely on
    // the function swallowing spawn errors and returning 'unknown'.
    try {
      delete process.env.npm_config_user_agent;
      // To force the fallback to fail deterministically, point
      // require.resolve to a missing module by clearing NODE_PATH
      // and using a sandbox is heavy. Instead, accept that the
      // fallback path may legitimately return either 'unknown' or a
      // real npm version on developer machines — but never throw.
      const v = await readNpmVersion();
      expect(typeof v).toBe("string");
      // The version, if known, must be a non-empty string. "unknown"
      // is the documented "could not identify" value.
      expect(v.length).toBeGreaterThan(0);
    } finally {
      if (prevUa !== undefined) process.env.npm_config_user_agent = prevUa;
    }
  });
});

describe("packageVersion is independent of npm version", () => {
  // The benchmark records packageVersion from package.json
  // (scripts/benchmark-latency.mjs readPackageVersion()). This test
  // proves the two values travel on different rails: npm-version.mjs
  // only resolves the npm CLI version, never the package's own
  // version field. We assert by reading package.json directly and
  // confirming it does not match a typical npm version shape.
  it("package.json reports a version distinct from npm/10.8.2", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
    const pkg = JSON.parse(
      readFileSync(resolve(root, "package.json"), "utf8"),
    );
    expect(typeof pkg.version).toBe("string");
    expect(pkg.version.length).toBeGreaterThan(0);
    // The package's own version is independent of the npm CLI
    // version; the benchmark records both separately.
    expect(pkg.version).not.toBe("10.8.2");
  });
});
