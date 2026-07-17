// scripts/lib/npm-version.mjs
//
// Resolve the npm CLI version that actually invoked this script.
//
// Preferred source: process.env.npm_config_user_agent. npm sets this
// when it runs scripts (e.g. `npm run benchmark:latency`). Its format
// is documented and stable:
//
//   npm/<version> node/<node-version> <platform> <arch>
//
// For example:
//   npm/10.8.2 node/v20.15.0 win32 x64
//
// We parse the "npm/<version>" token directly. We never reach for
// `process.execPath`'s bundled npm when npm_config_user_agent is
// present, because that npm is not necessarily the one that invoked
// us — on some machines two npm installations sit side by side.
//
// Fallback (only when invoked directly with `node`):
//   Locate npm/bin/npm-cli.js via require.resolve (the standard
//   pattern used by scripts/validate-package.mjs), spawn it through
//   process.execPath with shell:false and a bounded timeout, and ask
//   it for its version. If even that fails, report "unknown" — never
//   substitute a different npm installation silently.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve as pathResolve, dirname, join } from "node:path";

/**
 * Parse the npm version from an npm_config_user_agent string. Returns
 * null when the token is missing or malformed; the caller decides
 * whether to fall back.
 *
 * Recognised shapes:
 *   "npm/10.8.2 node/v20.15.0 win32 x64"          → "10.8.2"
 *   "npm/10.7.0 node/v20.14.0 linux x64"          → "10.7.0"
 *   "pnpm/9.0.0 npm/? node/v20.15.0 linux x64"    → null (no npm token)
 *   "yarn/1.22.22 npm/? node/v20.15.0"            → null
 *   ""                                           → null
 *
 * The npm token is matched as a positive-integer-like dotted
 * triple; whitespace, slashes, and surrounding context are tolerated.
 *
 * @param {string | undefined | null} ua
 * @returns {string | null}
 */
export function parseNpmFromUserAgent(ua) {
  if (typeof ua !== "string") return null;
  // Find any "npm/<version>" token in the agent string, anchored on
  // a word boundary so "npm/?", "npmnot/...", or run-together
  // garbage do not match.
  const m = ua.match(/(?:^|\s)npm\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=\s|$)/);
  if (!m) return null;
  return m[1];
}

/** Resolve the absolute path to npm/bin/npm-cli.js, or throw. */
export function resolveNpmCliJs() {
  try {
    return require.resolve("npm/bin/npm-cli.js");
  } catch {
    const exeDir = dirname(process.execPath);
    const candidates = [
      join(exeDir, "node_modules", "npm", "bin", "npm-cli.js"),
      join(exeDir, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    throw new Error("Could not locate npm CLI script (npm-cli.js)");
  }
}

/** Run `npm <args>` via process.execPath with bounded timeout. */
export function runNpm(args, timeoutMs = 5_000) {
  const npmCli = resolveNpmCliJs();
  return new Promise((resolveOne) => {
    const child = spawn(
      process.execPath,
      [npmCli, ...args],
      {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        detached: false,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr?.on("data", (b) => (stderr += b.toString("utf8")));
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveOne({ code: 1, stdout, stderr: stderr + String(err), timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveOne({ code: code ?? 1, stdout, stderr, timedOut: false });
    });
  });
}

/**
 * Return the npm CLI version string that invoked this script.
 *
 *   1. When npm_config_user_agent is set (the common `npm run`
 *      case), parse the npm/<version> token from it. This is the
 *      npm that actually ran `npm run benchmark:latency ...` and is
 *      the truthful source.
 *
 *   2. Otherwise (script invoked directly with `node`), spawn
 *      require.resolve('npm/bin/npm-cli.js') through process.execPath
 *      with shell:false and ask it for its version. This is a safe
 *      fallback because it uses the npm bundled with the running
 *      Node — not an arbitrary npm on PATH.
 *
 *   3. If both paths fail, return "unknown". Never throw — the
 *      metadata block must always be written.
 *
 * @returns {Promise<string>}
 */
export async function readNpmVersion() {
  const fromUa = parseNpmFromUserAgent(process.env.npm_config_user_agent);
  if (fromUa) return fromUa;
  try {
    const r = await runNpm(["--version"], 5_000);
    if (r.code !== 0) return "unknown";
    const out = r.stdout.trim();
    return out || "unknown";
  } catch {
    return "unknown";
  }
}
