#!/usr/bin/env node
/**
 * demo-states.mjs
 *
 * Standalone avatar demo. Cycles the avatar through every supported state
 * for a few seconds each, so a human can visually confirm the renderer
 * behaves correctly in their terminal pane.
 *
 * Sequence (per spec):
 *   hi -> idle -> think -> talk -> read -> write -> tool -> failure -> compact -> idle
 *
 * Acceptance:
 *   - ASCII works first (default).
 *   - Sixel works second (set CLAUDE_EMOTE_DEMO_PROTOCOL=sixel).
 *   - No continuous scrolling.
 *   - No ghost frame accumulation during a 30-second run.
 *   - Ctrl+C restores the cursor (SIGINT handler clears timers and
 *     shows the cursor before exit).
 *   - Existing emote sets load without conversion.
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(__filename, "..", "..");

const EXT_DIR = PROJECT_ROOT;
const EMOTE_SET_NAME = process.env.CLAUDE_EMOTE_DEMO_EMOTE_SET ?? "ascii";
const EMOTE_SET_DIR = resolve(EXT_DIR, "emotes", EMOTE_SET_NAME);

if (!existsSync(EMOTE_SET_DIR)) {
  console.error(`demo: emote set not found at ${EMOTE_SET_DIR}`);
  process.exit(1);
}

const DIST = resolve(PROJECT_ROOT, "dist");
const { Animator } = await import(`file://${resolve(DIST, "core/animator.js")}`);
const { createRenderer } = await import(`file://${resolve(DIST, "adapters/renderer-factory.js")}`);
const { StandaloneRenderHost } = await import(`file://${resolve(DIST, "adapters/standalone-render-host.js")}`);
const { loadLayeredConfig } = await import(`file://${resolve(DIST, "core/config.js")}`);
const { detectTerminalName } = await import(`file://${resolve(DIST, "core/terminal.js")}`);

// --- Load config + build renderer ------------------------------------------

const { config, userConfiguredTerminals } = loadLayeredConfig(EXT_DIR, process.cwd());

// Allow demo to force ASCII or Sixel from CLI.
const forced = process.env.CLAUDE_EMOTE_DEMO_PROTOCOL;
if (forced === "ascii" || forced === "sixel") {
  config.terminals = [
    ...config.terminals.filter((t) => !["windows-terminal", "unknown"].includes(t.match)),
    { match: detectTerminalName() || "unknown", render: forced },
  ];
  // Mark forced as user-configured to suppress any "defaulting to ASCII" warning.
  userConfiguredTerminals.add(detectTerminalName() || "unknown");
}

const { renderer, resolved } = createRenderer(config, EXT_DIR, EMOTE_SET_DIR, userConfiguredTerminals);
console.error(`[demo] terminal=${detectTerminalName()} protocol=${resolved.protocol} multiplexer=${resolved.multiplexer ?? "(none)"}`);
if (resolved.warning && resolved.warningLevel === "warning") {
  console.error(`[demo] warning: ${resolved.warning}`);
}

const host = new StandaloneRenderHost();
host.start();
renderer.setTui(host);

const animator = new Animator(config, renderer);

// Wire frame -> host so each show* call repaints.
const origSetFrame = (frame) => host.setCurrentFrame(frame);
renderer.getRenderedFrame = () => host.peekFrame();
// Re-implement getRenderedFrame to always reflect the host's cached frame.
renderer.getRenderedFrame = () => host.peekFrame();
// Track show* calls by hooking requestRender — host updates cache itself.

let timer = null;
let currentTalkHandle = null;

function transition(state, durationMs, withTalkTokens = false) {
  console.error(`[demo] -> ${state} (${durationMs}ms)`);
  animator.transitionTo(state);
  // For talk, feed a token every 250ms so the mouth alternates.
  if (state === "talk" && withTalkTokens) {
    const tokens = [
      "Hello",
      " world",
      " from",
      " claude",
      " emote",
      " demo",
      " mode",
      " today",
    ];
    let i = 0;
    currentTalkHandle = setInterval(() => {
      animator.onTalkToken(tokens[i % tokens.length]);
      i++;
    }, 250);
  } else if (currentTalkHandle) {
    clearInterval(currentTalkHandle);
    currentTalkHandle = null;
  }
  timer = setTimeout(next, durationMs);
}

const SEQUENCE = [
  ["hi", 1500],
  ["idle", 1500],
  ["think", 1500],
  ["talk", 3000, true],
  ["read", 2000],
  ["write", 2000],
  ["tool", 2000],
  ["failure", 1500],
  ["compact", 1500],
  ["idle", 1000],
];
let step = 0;
function next() {
  if (step >= SEQUENCE.length) {
    finish();
    return;
  }
  const [state, dur, withTokens] = SEQUENCE[step++];
  transition(state, dur, withTokens);
}

// Keep the host in sync with the Animator's current frame after every
// requestRender call. requestRender is debounced; the host will pull the
// renderer's current frame from peekFrame.
host.attachFrameSource(() => renderer.getRenderedFrame());

// --- Shutdown handling -----------------------------------------------------

let shuttingDown = false;
function finish() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (timer) clearTimeout(timer);
  if (currentTalkHandle) clearInterval(currentTalkHandle);
  animator.clearAllTimers();
  try {
    renderer.dispose();
  } catch {}
  host.shutdown();
  console.error("[demo] done.");
  process.exit(0);
}

process.on("SIGINT", () => {
  console.error("[demo] SIGINT — restoring cursor.");
  finish();
});
process.on("SIGTERM", () => finish());

// --- Start ------------------------------------------------------------------

next();
