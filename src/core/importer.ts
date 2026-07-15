import AdmZip from "adm-zip";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, normalize, parse, sep } from "node:path";
import { getUserExtensionDir } from "./paths.js";

const IMAGE_STATES = new Set(["hi", "idle", "think", "talk", "read", "write", "tool", "success", "failure", "compact"]);

export interface ImportResult {
  setName: string;
  targetDir: string;
  fileCount: number;
  warnings: string[];
}

export class EmoteSetExistsError extends Error {
  constructor(public readonly setName: string, public readonly targetDir: string) {
    super(`Emote set "${setName}" already exists.`);
    this.name = "EmoteSetExistsError";
  }
}

export function getUserEmotesDir(): string {
  return join(getUserExtensionDir(), "emotes");
}

function sanitizeSetName(name: string): string {
  const sanitized = name
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .replace(/_+/g, "_");
  return sanitized || "imported-emote";
}

function normalizeZipPath(path: string): string | null {
  const unixPath = path.replace(/\\/g, "/");
  if (!unixPath || unixPath.startsWith("/") || /^[A-Za-z]:/.test(unixPath)) return null;
  const normalized = normalize(unixPath).replace(/\\/g, "/");
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") return null;
  return normalized;
}

function stripRoot(path: string, rootPrefix: string | null): string {
  if (!rootPrefix) return path;
  return path === rootPrefix ? "" : path.slice(rootPrefix.length + 1);
}

function getZipRootPrefix(paths: string[]): string | null {
  const firstSegments = paths
    .map((path) => path.split("/").filter(Boolean)[0])
    .filter((segment): segment is string => Boolean(segment) && segment !== "__MACOSX");
  if (firstSegments.length === 0) return null;
  const first = firstSegments[0]!;
  return firstSegments.every((segment) => segment === first) ? first : null;
}

function validateEmotesJson(files: Map<string, Buffer>): string[] {
  const warnings: string[] = [];
  const raw = files.get("emotes.json");
  if (!raw) {
    warnings.push("No emotes.json found; idle/think/talk will use default filename conventions where possible.");
    return warnings;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw.toString("utf-8"));
  } catch (error) {
    throw new Error(`Invalid emotes.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const [section, values] of Object.entries({ idle: parsed.idle, think: parsed.think })) {
    if (!values || typeof values !== "object") continue;
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      if (typeof value !== "string") continue;
      const ref = `${section}/${value}`;
      if (!files.has(ref)) throw new Error(`emotes.json references missing file: ${section}.${key} -> ${ref}`);
    }
  }

  const weights = parsed.talk?.weights;
  if (weights && typeof weights === "object") {
    for (const value of Object.keys(weights)) {
      const ref = `talk/${value}`;
      if (!files.has(ref)) throw new Error(`emotes.json references missing talk weight file: ${ref}`);
    }
  }

  return warnings;
}

function validateImportedFiles(files: Map<string, Buffer>): string[] {
  const warnings: string[] = validateEmotesJson(files);
  let pngCount = 0;
  const statesWithPng = new Set<string>();

  for (const path of files.keys()) {
    const parts = path.split("/");
    if (parts.length < 2) continue;
    const state = parts[0]!;
    const file = parts[parts.length - 1]!;
    if (IMAGE_STATES.has(state) && file.endsWith(".png")) {
      pngCount++;
      statesWithPng.add(state);
    } else if (IMAGE_STATES.has(state) && file.toLowerCase().endsWith(".png") && !file.endsWith(".png")) {
      warnings.push(`Ignored uppercase PNG extension; pi-emote only loads lowercase .png: ${path}`);
    }
  }

  if (pngCount === 0) {
    throw new Error("Zip does not contain any lowercase .png frames under pi-emote state folders.");
  }

  if (!statesWithPng.has("idle")) warnings.push("No idle/*.png frames found; idle animation may be blank.");
  if (!statesWithPng.has("talk")) warnings.push("No talk/*.png frames found; talk animation may be blank.");

  return warnings;
}

export function importEmoteZip(zipPath: string, options: { overwrite?: boolean } = {}): ImportResult {
  if (!zipPath.toLowerCase().endsWith(".zip")) throw new Error("Selected file is not a .zip file.");
  if (!existsSync(zipPath)) throw new Error(`Zip file not found: ${zipPath}`);

  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const safePaths = entries
    .map((entry) => normalizeZipPath(entry.entryName))
    .filter((path): path is string => Boolean(path));
  const rootPrefix = getZipRootPrefix(safePaths);
  const setName = sanitizeSetName(rootPrefix ?? parse(basename(zipPath)).name);
  const targetDir = join(getUserEmotesDir(), setName);

  if (existsSync(targetDir) && !options.overwrite) {
    throw new EmoteSetExistsError(setName, targetDir);
  }

  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const normalized = normalizeZipPath(entry.entryName);
    if (!normalized) throw new Error(`Unsafe zip entry path: ${entry.entryName}`);
    if (normalized.startsWith("__MACOSX/")) continue;
    const relative = stripRoot(normalized, rootPrefix);
    if (!relative || relative.includes("/") && relative.split("/").some((part) => !part)) continue;
    if (relative.startsWith("__MACOSX/")) continue;
    files.set(relative, entry.getData());
  }

  const warnings = validateImportedFiles(files);

  mkdirSync(dirname(targetDir), { recursive: true });
  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });

  let fileCount = 0;
  for (const [relative, data] of files.entries()) {
    const destination = join(targetDir, ...relative.split("/"));
    const normalizedDestination = normalize(destination);
    const normalizedTarget = normalize(targetDir + sep);
    if (!normalizedDestination.startsWith(normalizedTarget)) {
      throw new Error(`Unsafe extraction target: ${relative}`);
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, data);
    fileCount++;
  }

  return { setName, targetDir, fileCount, warnings };
}
