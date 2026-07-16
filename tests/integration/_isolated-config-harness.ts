/**
 * _isolated-config-harness.ts
 *
 * Test-only helper that creates an isolated ASCII-forcing project
 * config inside a unique temp directory, and removes that directory on
 * cleanup.
 *
 * The production-path frame-output test and the harness-safety
 * regression tests BOTH call `createIsolatedAsciiHarness()` so they
 * exercise the exact same implementation.
 *
 * Safety contract:
 *   - The helper NEVER reads, writes, deletes, or requires absence of
 *     any path under the real PROJECT_ROOT.
 *   - Every operation is scoped to a unique mkdtempSync() result under
 *     os.tmpdir().
 *   - cleanup() is idempotent and safe to call multiple times.
 *   - cleanup() never follows symlinks or removes files outside its
 *     own temp directory.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface IsolatedConfigHarness {
  /** Absolute path of the temp directory created and owned by this harness. */
  tempDir: string;
  /** Absolute path of the ASCII override config.json inside tempDir. */
  configPath: string;
  /**
   * Remove the harness-owned temp directory. Idempotent. Safe to call
   * from afterAll, from catch blocks in beforeAll, or multiple times
   * from any location. Never touches anything outside tempDir.
   */
  cleanup(): Promise<void>;
}

/**
 * Create an isolated ASCII-forcing project config under
 * `${os.tmpdir()}/claude-emote-harness-<random>/.claude-emote/extensions/claude-emote/config.json`.
 *
 * The returned harness is the only state needed to clean up.
 */
export function createIsolatedAsciiHarness(): IsolatedConfigHarness {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-emote-harness-"));
  const configDir = join(
    tempDir,
    ".claude-emote",
    "extensions",
    "claude-emote",
  );
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      { terminals: [{ match: "unknown", render: "ascii" }] },
      null,
      2,
    ),
    "utf8",
  );

  let cleaned = false;
  let cleanupPromise: Promise<void> | null = null;

  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      if (cleaned) return;
      cleaned = true;
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort: tempdir cleanup must never throw
      }
    })();
    return cleanupPromise;
  };

  return { tempDir, configPath, cleanup };
}