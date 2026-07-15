#!/usr/bin/env node
/**
 * bin/claude-emote.cjs
 *
 * Placeholder for M3. The full launcher (Windows Terminal pane management,
 * port allocation, health handshake, child process orchestration) is
 * implemented in Milestone 4 at `src/launcher/claude-emote.ts`.
 *
 * For now this entry point prints a useful error so anyone running
 * `claude-emote` before M4 lands gets a clear message.
 */

const path = require("node:path");

console.error(
  "[claude-emote] Launcher not yet built — this is the M3 placeholder.",
);
console.error(
  "[claude-emote] The full launcher ships in Milestone 4 (src/launcher/claude-emote.ts).",
);
console.error(
  "[claude-emote] For now, you can manually run the avatar server and bridge independently:",
);
console.error("");
console.error("  1. Build:                  npm run build");
console.error("  2. Start the avatar:       node dist/host/avatar-process.js");
console.error("  3. Set the endpoint:       $env:CLAUDE_EMOTE_ENDPOINT='http://127.0.0.1:<port>/event'");
console.error("  4. Configure your hook to point at dist/claude/hook-bridge.js");
console.error("");
console.error("See docs/HOOK_PROTOCOL.md for the contract details.");
process.exit(1);
