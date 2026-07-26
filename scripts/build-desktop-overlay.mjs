#!/usr/bin/env node

import {
  copyFile,
  cp,
  mkdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const desktopRoot = join(projectRoot, "desktop");
const sourceRoot = join(desktopRoot, "src");
const outputRoot = join(desktopRoot, "resources");
const manifestPath = join(desktopRoot, "asset-manifest.json");
const neutralinoConfigPath = join(desktopRoot, "neutralino.config.json");

async function requireFile(path, description) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) {
    throw new Error(`Missing ${description}: ${path}`);
  }
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const neutralinoConfig = JSON.parse(
  await readFile(neutralinoConfigPath, "utf8"),
);
if (
  typeof manifest.sourceDirectory !== "string" ||
  typeof manifest.activities !== "object" ||
  manifest.activities === null
) {
  throw new Error("desktop/asset-manifest.json has an invalid shape");
}

const assetSourceRoot = resolve(projectRoot, manifest.sourceDirectory);
if (
  isAbsolute(manifest.sourceDirectory) ||
  !assetSourceRoot.startsWith(projectRoot + sep)
) {
  throw new Error("Asset sourceDirectory must stay inside the repository");
}
const configuredResourcesRoot = resolve(
  desktopRoot,
  String(neutralinoConfig.cli?.resourcesPath ?? "").replace(/^[/\\]+/, ""),
);
const packageOutputRoot = resolve(desktopRoot, "dist");
const comparablePath = (path) =>
  process.platform === "win32" ? path.toLowerCase() : path;
if (comparablePath(configuredResourcesRoot) !== comparablePath(outputRoot)) {
  throw new Error(
    `Neutralino resourcesPath resolves to ${configuredResourcesRoot}, expected ${outputRoot}`,
  );
}
if (comparablePath(configuredResourcesRoot) === comparablePath(packageOutputRoot)) {
  throw new Error(
    "Neutralino web resources and package output must use different directories",
  );
}
const framePaths = new Set();
for (const [activity, definition] of Object.entries(manifest.activities)) {
  if (
    typeof definition.label !== "string" ||
    definition.label.length === 0 ||
    typeof definition.intervalMs !== "number" ||
    !Number.isFinite(definition.intervalMs) ||
    definition.intervalMs <= 0 ||
    !Array.isArray(definition.frames) ||
    definition.frames.length === 0
  ) {
    throw new Error(
      `Activity "${activity}" must declare a label, positive interval, and frames`,
    );
  }
  for (const relativePath of definition.frames) {
    if (
      typeof relativePath !== "string" ||
      relativePath.startsWith("/") ||
      relativePath.includes("..")
    ) {
      throw new Error(`Activity "${activity}" has an unsafe frame path`);
    }
    framePaths.add(relativePath);
  }
}

for (const relativePath of framePaths) {
  await requireFile(
    join(assetSourceRoot, relativePath),
    `frame declared by desktop/asset-manifest.json`,
  );
}

const configuredIconPath = resolve(
  desktopRoot,
  String(neutralinoConfig.modes?.window?.icon ?? "").replace(/^[/\\]+/, ""),
);

await rm(outputRoot, { recursive: true, force: true });
await mkdir(join(outputRoot, "assets", "default"), { recursive: true });
await copyFile(join(sourceRoot, "index.html"), join(outputRoot, "index.html"));
await copyFile(join(sourceRoot, "styles.css"), join(outputRoot, "styles.css"));
await copyFile(
  join(projectRoot, "THIRD_PARTY_NOTICES.md"),
  join(outputRoot, "THIRD_PARTY_NOTICES.md"),
);
await copyFile(
  join(
    projectRoot,
    "node_modules",
    "@neutralinojs",
    "lib",
    "dist",
    "neutralino.js",
  ),
  join(outputRoot, "neutralino.js"),
);

for (const relativePath of framePaths) {
  const destination = join(outputRoot, "assets", "default", relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await cp(join(assetSourceRoot, relativePath), destination);
}

await requireFile(configuredIconPath, "Neutralino window icon");

await build({
  entryPoints: [join(sourceRoot, "main.ts")],
  outfile: join(outputRoot, "app.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["edge100", "chrome100", "safari15"],
  sourcemap: true,
  logLevel: "warning",
});

console.log(
  `[overlay] built ${framePaths.size} validated frames into ${outputRoot}`,
);
