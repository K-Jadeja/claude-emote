/**
 * avatar-args.ts
 *
 * Pure argument parser for the avatar process CLI. Public API:
 *
 *   export interface AvatarProcessOptions {
 *     port: number;
 *     instanceId: string;
 *     emoteDir: string;
 *     parentPid: number | null;
 *   }
 *
 *   export function parseAvatarProcessOptions(
 *     argv: string[],
 *     env: NodeJS.ProcessEnv,
 *   ): AvatarProcessOptions
 *
 * Three-state validation per field:
 *
 *   1. value not supplied      → fall back to env, then to documented default
 *   2. valid value supplied    → use it
 *   3. invalid value supplied  → throw AvatarParseError
 *
 * Resolution priority per field (highest first):
 *
 *   valid explicit CLI value
 *   valid environment value
 *   documented default
 *
 * Invalid explicit CLI values throw BEFORE environment fallback. Invalid
 * environment values throw (they do not silently fall back to defaults).
 *
 * The parser is pure with respect to (argv, env, process.cwd()): same
 * inputs always produce the same outputs.
 */

export interface AvatarProcessOptions {
  port: number;
  instanceId: string;
  /**
   * Resolved emote directory, or the empty string `""` to indicate that
   * the caller did not supply a custom path via `--emoteDir` or
   * `CLAUDE_EMOTE_EMOTE_DIR`. The avatar process interprets `""` as
   * "automatic bundled selection" and chooses the bundled set that
   * matches the resolved renderer kind.
   *
   * Phase 4 strict-validation rules are preserved: explicit
   * `--emoteDir=<empty>` still throws `requires a non-empty value`.
   */
  emoteDir: string;
  parentPid: number | null;
}

export class AvatarParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvatarParseError";
  }
}

const FLAG_NAMES = ["port", "instance", "emoteDir", "parentPid"] as const;
type FlagName = (typeof FLAG_NAMES)[number];

/** Map CLI flag name to its corresponding environment variable. */
const FLAG_TO_ENV: Record<FlagName, string> = {
  port: "CLAUDE_EMOTE_PORT",
  instance: "CLAUDE_EMOTE_INSTANCE_ID",
  emoteDir: "CLAUDE_EMOTE_EMOTE_DIR",
  parentPid: "CLAUDE_EMOTE_PARENT_PID",
};

interface FlagOccurrence {
  /** True when the flag appears anywhere on the command line. */
  present: boolean;
  /**
   * The captured value:
   *   - string for --flag=value or --flag value (both forms)
   *   - null for bare --flag with no value (e.g. --port with nothing after,
   *     or --port followed immediately by another --flag).
   *   - undefined for "not present"
   */
  value: string | null | undefined;
}

/** Read every occurrence of the four known flags out of argv. */
function scanCli(argv: string[]): Map<FlagName, FlagOccurrence> {
  const out = new Map<FlagName, FlagOccurrence>();
  for (const name of FLAG_NAMES) {
    out.set(name, { present: false, value: undefined });
  }

  let i = 0;
  while (i < argv.length) {
    const token = argv[i]!;
    let matched: FlagName | null = null;
    for (const name of FLAG_NAMES) {
      const prefix = `--${name}`;
      if (token === prefix || token.startsWith(`${prefix}=`)) {
        matched = name;
        break;
      }
    }
    if (matched === null) {
      i++;
      continue;
    }
    const prefix = `--${matched}`;
    if (token.startsWith(`${prefix}=`)) {
      // --flag=value
      const value = token.slice(prefix.length + 1);
      out.set(matched, { present: true, value });
      i++;
      continue;
    }
    // --flag (two-arg form)
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      // Bare flag with no value, or followed immediately by another flag.
      out.set(matched, { present: true, value: null });
      i++;
      continue;
    }
    out.set(matched, { present: true, value: next });
    i += 2;
  }

  return out;
}

function isBlank(s: string): boolean {
  return s.trim() === "";
}

function resolveStringField(
  name: FlagName,
  occ: FlagOccurrence,
  envValue: string | undefined,
  defaultValue: () => string,
): string {
  if (occ.present) {
    if (occ.value === null || occ.value === undefined || isBlank(occ.value)) {
      throw new AvatarParseError(`--${name} requires a non-empty value`);
    }
    return occ.value;
  }
  if (envValue !== undefined) {
    if (isBlank(envValue)) {
      throw new AvatarParseError(
        `${FLAG_TO_ENV[name]} must not be empty`,
      );
    }
    return envValue;
  }
  return defaultValue();
}

function resolvePortField(
  occ: FlagOccurrence,
  envValue: string | undefined,
): number {
  if (occ.present) {
    if (occ.value === null || occ.value === undefined || occ.value === "") {
      throw new AvatarParseError(`--port requires a value`);
    }
    const n = Number(occ.value);
    if (!Number.isInteger(n)) {
      throw new AvatarParseError(
        `--port must be an integer, got "${occ.value}"`,
      );
    }
    if (n < 0 || n > 65535) {
      throw new AvatarParseError(
        `--port must be in [0, 65535], got ${n}`,
      );
    }
    return n;
  }
  if (envValue !== undefined && envValue !== "") {
    const n = Number(envValue);
    if (!Number.isInteger(n)) {
      throw new AvatarParseError(
        `CLAUDE_EMOTE_PORT must be an integer, got "${envValue}"`,
      );
    }
    if (n < 0 || n > 65535) {
      throw new AvatarParseError(
        `CLAUDE_EMOTE_PORT must be in [0, 65535], got ${n}`,
      );
    }
    return n;
  }
  return 0;
}

function resolveParentPidField(
  occ: FlagOccurrence,
  envValue: string | undefined,
): number | null {
  if (occ.present) {
    if (occ.value === null || occ.value === undefined || occ.value === "") {
      throw new AvatarParseError(`--parentPid requires a value`);
    }
    const n = Number(occ.value);
    if (!Number.isInteger(n)) {
      throw new AvatarParseError(
        `--parentPid must be an integer, got "${occ.value}"`,
      );
    }
    if (n < 1) {
      throw new AvatarParseError(
        `--parentPid must be a positive integer, got ${n}`,
      );
    }
    return n;
  }
  if (envValue !== undefined && envValue !== "") {
    const n = Number(envValue);
    if (!Number.isInteger(n)) {
      throw new AvatarParseError(
        `CLAUDE_EMOTE_PARENT_PID must be an integer, got "${envValue}"`,
      );
    }
    if (n < 1) {
      throw new AvatarParseError(
        `CLAUDE_EMOTE_PARENT_PID must be a positive integer, got ${n}`,
      );
    }
    return n;
  }
  return null;
}

/** Single public entry point. */
export function parseAvatarProcessOptions(
  argv: string[],
  env: NodeJS.ProcessEnv,
): AvatarProcessOptions {
  const cli = scanCli(argv);
  const envPort = env.CLAUDE_EMOTE_PORT;
  const envInstance = env.CLAUDE_EMOTE_INSTANCE_ID;
  const envEmoteDir = env.CLAUDE_EMOTE_EMOTE_DIR;
  const envParentPid = env.CLAUDE_EMOTE_PARENT_PID;

  const port = resolvePortField(cli.get("port")!, envPort);
  const instanceId = resolveStringField(
    "instance",
    cli.get("instance")!,
    envInstance,
    () => "standalone",
  );
  // emoteDir default: an empty string means "automatic bundled
  // selection". The avatar process resolves the actual bundled
  // directory based on the resolved renderer kind (see
  // src/shared/emote-selection.ts). This keeps the parser pure with
  // respect to (argv, env) — no filesystem or process.cwd() lookup.
  const emoteDir = resolveStringField(
    "emoteDir",
    cli.get("emoteDir")!,
    envEmoteDir,
    () => "",
  );
  const parentPid = resolveParentPidField(
    cli.get("parentPid")!,
    envParentPid,
  );

  return { port, instanceId, emoteDir, parentPid };
}