/**
 * project-paths.ts
 *
 * Phase 6: authoritative package-root path resolution.
 *
 * The installed claude-emote package ships bundled emotes at:
 *
 *   <PACKAGE_ROOT>/emotes/default     ← image-capable renderers
 *   <PACKAGE_ROOT>/emotes/ascii       ← ASCII renderer
 *
 * PACKAGE_ROOT is derived from this module's own file location, not
 * from process.cwd(). That makes the bundled paths work in all of:
 *
 *   - executed from the repository root
 *   - executed from any other working directory
 *   - installed globally (npm install -g)
 *   - invoked through the compiled dist files
 *
 * This module does NOT choose an emote set, validate one, or even
 * know which renderer is active. It only resolves filesystem paths.
 * Emote-set selection lives in src/shared/emote-selection.ts.
 */

import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path of the claude-emote package root, derived from the
 * location of THIS compiled module. Works for both source (`src/`) and
 * dist (`dist/`) invocations.
 *
 * Source layout:        src/shared/project-paths.ts → ../../ = package root
 * Compiled layout:      dist/shared/project-paths.js → ../../ = package root
 */
function derivePackageRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return resolve(dirname(here), "..", "..");
}

export const PACKAGE_ROOT: string = derivePackageRoot();

/** Bundled image emote set (Kitty / iTerm2 / Sixel / tmux-image). */
export const BUNDLED_IMAGE_EMOTE_DIR: string = join(PACKAGE_ROOT, "emotes", "default");

/** Bundled ASCII emote set (text fallback). */
export const BUNDLED_ASCII_EMOTE_DIR: string = join(PACKAGE_ROOT, "emotes", "ascii");