/**
 * renderer-factory.ts
 *
 * Selects and constructs an upstream Renderer class based on terminal
 * capability detection. Mirrors the resolution logic in
 * `src/core/terminal.ts` but constructs the concrete renderer instance
 * rather than just reporting the protocol.
 *
 * V1 behaviour:
 *   - First support ASCII (always available, no external dependencies).
 *   - Then enable Sixel on Windows Terminal through Chafa.
 *   - All other protocols (Kitty/iTerm2/tmux-passthrough) remain selectable
 *     for future ports but are not auto-selected on Windows Terminal.
 */

import { join } from "node:path";
import { AsciiRenderer } from "../core/render_ascii.js";
import { SixelRenderer } from "../core/render_sixel.js";
import { KittyRenderer } from "../core/render_kitty.js";
import { ITermRenderer } from "../core/render_iterm.js";
import { TmuxKittyRenderer } from "../core/render_tmux_kitty.js";
import { TmuxITermRenderer } from "../core/render_tmux_iterm.js";
import { TmuxKittyUnicodeRenderer } from "../core/render_tmux_kitty_unicode.js";
import { WezTermITermRenderer } from "../core/render_wezterm_iterm.js";
import type { Renderer } from "../core/renderer.js";
import type { ResolvedRenderer } from "../core/types.js";
import { resolveRenderer, detectTerminalName } from "../core/terminal.js";
import type { Config } from "../core/types.js";

export interface RendererFactoryResult {
  renderer: Renderer;
  resolved: ResolvedRenderer;
  setTuiHost: (host: { requestRender: () => void } | null) => void;
}

/** Build a renderer instance for the given resolved protocol. */
export function buildRenderer(resolved: ResolvedRenderer, config: Config): Renderer {
  const size = config.imageSize ?? config.size;
  switch (resolved.protocol) {
    case "ascii":
      return new AsciiRenderer();
    case "sixel":
      return new SixelRenderer(size);
    case "kitty":
      return new KittyRenderer(size);
    case "iterm2":
      return new ITermRenderer(size);
    case "kitty-unicode":
      return new TmuxKittyUnicodeRenderer(size);
    default:
      // Fall back to ASCII — never crash the avatar process over a renderer.
      return new AsciiRenderer();
  }
}

/**
 * Construct the appropriate renderer for the current terminal + emote
 * directory. `userConfiguredTerminals` is the set of `terminals[*].match`
 * keys explicitly set in user/project config (used to suppress warnings).
 */
export function createRenderer(
  config: Config,
  extDir: string,
  emoteSetDir: string,
  userConfiguredTerminals: Set<string> = new Set(),
): RendererFactoryResult {
  const resolved = resolveRenderer(config.terminals, userConfiguredTerminals);
  // For tmux auto-passthrough, we need a different concrete class.
  let renderer: Renderer;
  if (resolved.multiplexer === "tmux") {
    if (resolved.protocol === "kitty") renderer = new TmuxKittyRenderer(config.imageSize ?? config.size);
    else if (resolved.protocol === "kitty-unicode") renderer = new TmuxKittyUnicodeRenderer(config.imageSize ?? config.size);
    else if (resolved.protocol === "iterm2") renderer = new TmuxITermRenderer(config.imageSize ?? config.size);
    else renderer = new AsciiRenderer();
  } else if (resolved.protocol === "iterm2" && detectTerminalName() === "wezterm") {
    renderer = new WezTermITermRenderer(config.size);
  } else {
    renderer = buildRenderer(resolved, config);
  }

  // Load frames into the renderer. For ASCII this reads ascii.yaml; for
  // image renderers this scans the emote set directory.
  renderer.loadFrames(emoteSetDir, extDir);

  return {
    renderer,
    resolved,
    setTuiHost(host) {
      // The renderers were written against pi-tui's TUI type but only ever
      // touch `.requestRender()`. Cast through `unknown` so we don't have
      // to change the copied renderer files.
      (renderer.setTui as unknown as (t: unknown) => void)(host);
    },
  };
}

/** Helper for the demo and the avatar process to obtain an emote-set dir. */
export function resolveEmoteSetDir(emoteSetName: string, extDir: string): string {
  return join(extDir, "emotes", emoteSetName);
}
