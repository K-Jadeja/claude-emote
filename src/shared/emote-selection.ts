/**
 * emote-selection.ts
 *
 * Phase 6: one authoritative module that decides which emote directory
 * the avatar process should use, based on:
 *
 *   1. The parser's emoteDir value (empty string = automatic)
 *   2. The resolved renderer kind (ascii vs image)
 *
 * The output is always an absolute path. Custom paths are returned
 * verbatim (with whitespace preserved); automatic selection returns
 * one of the bundled directories from src/shared/project-paths.ts.
 *
 * This module does NOT validate the directory. Validation lives in
 * src/shared/emote-validation.ts so callers can run validation
 * separately with their own error messages.
 */

import { isAbsolute, resolve } from "node:path";
import {
  BUNDLED_ASCII_EMOTE_DIR,
  BUNDLED_IMAGE_EMOTE_DIR,
} from "./project-paths.js";
import type { RendererKind } from "./emote-validation.js";

export type EmoteSelectionKind = "automatic" | "custom";

export interface EmoteSelection {
  /**
   * - "automatic" — the caller did not supply a custom path. The
   *   bundled set that matches the renderer kind is used.
   * - "custom" — the caller supplied `--emoteDir` or
   *   `CLAUDE_EMOTE_EMOTE_DIR`. The custom path is honored verbatim
   *   (resolved to absolute if it was not already).
   */
  kind: EmoteSelectionKind;
  /** Absolute path to the directory the avatar should load frames from. */
  directory: string;
}

/**
 * Resolve the effective emote selection from the parser's emoteDir
 * value and the resolved renderer kind.
 *
 * Parser contract:
 *   - ""        → automatic bundled selection
 *   - "<path>"  → custom; path is preserved verbatim (whitespace OK)
 */
export function resolveEmoteSelection(
  parserEmoteDir: string,
  rendererKind: RendererKind,
): EmoteSelection {
  if (parserEmoteDir === "") {
    const bundled =
      rendererKind === "ascii"
        ? BUNDLED_ASCII_EMOTE_DIR
        : BUNDLED_IMAGE_EMOTE_DIR;
    return { kind: "automatic", directory: bundled };
  }
  // Custom path: resolve to absolute but do not touch its contents.
  // This preserves user intent including paths with spaces.
  return {
    kind: "custom",
    directory: isAbsolute(parserEmoteDir)
      ? parserEmoteDir
      : resolve(parserEmoteDir),
  };
}