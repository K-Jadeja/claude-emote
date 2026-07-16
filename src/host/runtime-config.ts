/**
 * runtime-config.ts
 *
 * Phase 6 proof-quality repair: the single production boundary for
 * loading the avatar's runtime configuration.
 *
 * Why this module exists:
 *   The previous production call was
 *       loadLayeredConfig(process.cwd(), process.cwd())
 *   which silently conflated two distinct arguments:
 *     - extDir: the claude-emote PACKAGE_ROOT (location of the
 *               bundled <PACKAGE_ROOT>/config.json; lowest-priority
 *               extension layer)
 *     - cwd:    the user's current project (location of the
 *               optional <cwd>/.claude-emote/extensions/claude-emote/
 *               config.json; highest-priority project layer)
 *   When the avatar ran from an unrelated project directory the
 *   bundled config.json was never loaded, which broke installed
 *   usage.
 *
 * This module owns the authoritative call:
 *   loadAvatarRuntimeConfig(projectCwd) returns the merged
 *   configuration with PACKAGE_ROOT as the extension argument and
 *   the caller-supplied projectCwd as the project argument.
 *
 * avatar-process.ts calls this helper. Tests can call it directly
 * to assert the exact production boundary without spawning the
 * avatar process.
 *
 * No dependency injection, no mocking frameworks, no generic
 * configuration service.
 */

import { loadLayeredConfig } from "../core/config.js";
import type { ConfigResult } from "../core/config.js";
import { PACKAGE_ROOT } from "../shared/project-paths.js";

/**
 * Load the avatar runtime configuration from the layered-config
 * sources.
 *
 *   1. <PACKAGE_ROOT>/config.json            (extension layer)
 *   2. user global config                    (user layer)
 *   3. <projectCwd>/.claude-emote/extensions/
 *      claude-emote/config.json              (project layer)
 *
 * The merged result is dominated by the project layer when present.
 */
export function loadAvatarRuntimeConfig(projectCwd: string): ConfigResult {
  return loadLayeredConfig(PACKAGE_ROOT, projectCwd);
}