#!/usr/bin/env node

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const desktopRoot = join(projectRoot, "desktop");
const runtimeByPlatform = {
  win32: "neutralino-win_x64.exe",
  linux: process.arch === "arm64"
    ? "neutralino-linux_arm64"
    : "neutralino-linux_x64",
  darwin: process.arch === "arm64"
    ? "neutralino-mac_arm64"
    : "neutralino-mac_x64",
};
const runtimeName = runtimeByPlatform[process.platform];

if (!runtimeName) {
  console.error(`[overlay] unsupported development platform: ${process.platform}`);
  process.exit(1);
}

const runtimePath = join(desktopRoot, "bin", runtimeName);
if (existsSync(runtimePath)) {
  console.log(`[overlay] Neutralino runtime ready: ${runtimeName}`);
  process.exit(0);
}

console.log("[overlay] Neutralino runtime is missing; downloading pinned runtime...");
const cliPath = join(
  projectRoot,
  "node_modules",
  "@neutralinojs",
  "neu",
  "bin",
  "neu.js",
);
const result = spawnSync(process.execPath, [cliPath, "update"], {
  cwd: desktopRoot,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0 || !existsSync(runtimePath)) {
  console.error(
    `[overlay] runtime preparation failed; expected ${runtimePath}`,
  );
  process.exit(result.status || 1);
}
