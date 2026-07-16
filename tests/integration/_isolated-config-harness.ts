/**
 * _isolated-config-harness.ts
 *
 * Helpers used by the harness-safety regression tests to install and
 * remove an isolated ASCII-forcing project config WITHOUT touching the
 * real project root. The live frame-output test inlines equivalent
 * logic so it can run a single child under teardown control.
 *
 * IMPORTANT: This module never writes anywhere under process.cwd() or
 * the real project root. All file operations happen inside a tempdir
 * returned by mkdtempSync().
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function setupIsolatedHarnessForTest(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-emote-p5-test-"));
  const configDir = join(tempDir, ".claude-emote", "extensions", "claude-emote");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify(
      { terminals: [{ match: "unknown", render: "ascii" }] },
      null,
      2,
    ),
    "utf8",
  );
  return tempDir;
}

export async function cleanupIsolatedHarnessForTest(tempDir: string): Promise<void> {
  if (!tempDir) return;
  rmSync(tempDir, { recursive: true, force: true });
}