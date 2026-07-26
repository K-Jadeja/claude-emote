import { basename, parse, resolve, win32 } from "node:path";
import {
  HIDE_SESSION_LABEL_ENV,
  SESSION_LABEL_ENV,
} from "../shared/session-label.js";

export {
  HIDE_SESSION_LABEL_ENV,
  SESSION_LABEL_ENV,
} from "../shared/session-label.js";

export const MAX_SESSION_LABEL_CODE_POINTS = 48;

function sanitizeSessionLabel(value: string): string {
  const withoutUnsafeControls = value
    .normalize("NFC")
    // Remove C0/C1 controls and Unicode bidi direction overrides. The latter
    // can make a visible label misleading even though it contains no markup.
    .replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, "");
  const compact = withoutUnsafeControls.replace(/\s+/gu, " ").trim();
  return Array.from(compact)
    .slice(0, MAX_SESSION_LABEL_CODE_POINTS)
    .join("");
}

function currentDirectoryName(cwd: string): string {
  const pathApi = cwd.includes("\\") ? win32 : { basename, parse, resolve };
  const absolute = pathApi.resolve(cwd);
  const leaf = pathApi.basename(absolute);
  if (leaf) return leaf;

  // Filesystem roots have no basename. Keep the derived root name short
  // without retaining or transporting the full current working directory.
  const root = pathApi.parse(absolute).root.replace(/[\\/]+$/u, "");
  return root || "root";
}

/**
 * Resolve presentation-only session identity.
 *
 * The default is derived solely from the final directory component. The full
 * cwd is never returned, retained, logged, or sent to another process.
 */
export function resolveSessionLabel(
  cwd: string,
  env: NodeJS.ProcessEnv,
): string | null {
  if (env[HIDE_SESSION_LABEL_ENV] === "1") return null;

  const hasExplicitLabel = Object.prototype.hasOwnProperty.call(
    env,
    SESSION_LABEL_ENV,
  );
  const source = hasExplicitLabel
    ? env[SESSION_LABEL_ENV] ?? ""
    : currentDirectoryName(cwd);
  const label = sanitizeSessionLabel(source);
  if (!label) {
    const origin = hasExplicitLabel
      ? SESSION_LABEL_ENV
      : "the current directory name";
    throw new Error(`${origin} must contain a visible character`);
  }
  return label;
}
