#!/usr/bin/env node
/**
 * bin/claude-emote.cjs
 *
 * Thin CJS wrapper around the compiled launcher at
 * dist/launcher/claude-emote.js. The TypeScript source lives in
 * src/launcher/claude-emote.ts; this shim exists so `npm install -g`
 * can wire up the `claude-emote` bin entry on any platform.
 */

const path = require("node:path");
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");

const projectRoot = path.resolve(__dirname, "..");
const launcher = path.join(projectRoot, "dist", "launcher", "claude-emote.js");

if (!existsSync(launcher)) {
  console.error(
    "[claude-emote] dist/launcher/claude-emote.js not found. Run `npm run build` first.",
  );
  process.exit(1);
}

const child = spawn(process.execPath, [launcher, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
child.on("close", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error(`[claude-emote] failed to start launcher: ${err.message}`);
  process.exit(1);
});
