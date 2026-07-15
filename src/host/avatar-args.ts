/**
 * avatar-args.ts
 *
 * Pure argument parser for the avatar process CLI. Kept separate so the
 * parsing logic can be unit-tested without spawning a process.
 *
 * Resolution priority (highest first):
 *   1. CLI argument (--port=1234 or --port 1234)
 *   2. Environment variable (CLAUDE_EMOTE_PORT, etc.)
 *   3. Safe default
 *
 * Only the flags documented for the avatar are parsed. Anything else
 * (e.g. a stray path) is left in `unknown[]` so callers can detect a
 * misuse without crashing the process.
 */

const KNOWN_FLAGS = new Set([
  "--port",
  "--instance",
  "--emoteDir",
  "--parentPid",
]);

export interface AvatarConfig {
  /** Resolved TCP port. 0 means "let the OS pick". */
  port: number;
  /** Resolved instance id (defaults to a per-process local id). */
  instanceId: string;
  /** Resolved emote-set directory or null when none supplied. */
  emoteDir: string | null;
  /** Resolved parent PID (0 when unknown / not supplied). */
  parentPid: number;
}

export interface ParsedArgs {
  config: AvatarConfig;
  /** argv entries that did not match any known avatar flag. */
  unknown: string[];
}

const DEFAULTS: AvatarConfig = {
  port: 0,
  instanceId: "",
  emoteDir: null,
  parentPid: 0,
};

/**
 * Parse a CLI argv list into an AvatarConfig. Supports:
 *   --port=1234      and  --port 1234
 *   --instance=abc   and  --instance abc
 *   --emoteDir=...   and  --emoteDir ...
 *   --parentPid=N    and  --parentPid N
 */
export function parseCliArgs(argv: string[]): Partial<AvatarConfig> {
  const out: Partial<AvatarConfig> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;

    // --flag=value form.
    const eq = a.indexOf("=");
    if (eq > 0 && a.startsWith("--")) {
      const flag = a.slice(0, eq);
      const value = a.slice(eq + 1);
      if (KNOWN_FLAGS.has(flag)) {
        applyFlag(out, flag, value);
        continue;
      }
    }

    // --flag value form (two-arg). When value looks like another flag
    // we treat it as missing — the caller will fall back to env.
    if (KNOWN_FLAGS.has(a)) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        applyFlag(out, a, next);
        i++;
      }
    }
  }
  return out;
}

function applyFlag(out: Partial<AvatarConfig>, flag: string, value: string): void {
  switch (flag) {
    case "--port": {
      const n = Number(value);
      if (Number.isFinite(n)) out.port = n;
      break;
    }
    case "--instance": {
      out.instanceId = value;
      break;
    }
    case "--emoteDir": {
      out.emoteDir = value;
      break;
    }
    case "--parentPid": {
      const n = Number(value);
      if (Number.isFinite(n)) out.parentPid = n;
      break;
    }
  }
}

/**
 * Resolve a single field with CLI > env > default priority.
 *
 * `env` is passed in (not read from process.env) so unit tests can drive
 * the resolver without mutating global state.
 */
function resolve<T>(
  flag: string,
  envName: string,
  env: NodeJS.ProcessEnv,
  cliValue: T | undefined,
  parse: (raw: string) => T | undefined,
  fallback: T,
): T {
  if (cliValue !== undefined) {
    dbgSet(`[avatar-args] ${flag}: from CLI = ${String(cliValue)}`);
    return cliValue;
  }
  const envRaw = env[envName];
  if (envRaw !== undefined && envRaw !== "") {
    const parsed = parse(envRaw);
    if (parsed !== undefined) {
      dbgSet(`[avatar-args] ${flag}: from env ${envName} = ${String(parsed)}`);
      return parsed;
    }
  }
  dbgSet(`[avatar-args] ${flag}: default = ${String(fallback)}`);
  return fallback;
}

let dbgSink: ((msg: string) => void) | null = null;
export function setAvatarArgsDebug(sink: ((msg: string) => void) | null): void {
  dbgSink = sink;
}
function dbgSet(msg: string): void {
  if (dbgSink) dbgSink(msg);
}

/**
 * Read `process.env` exactly once (so tests can pass a stub env) and
 * combine it with parsed CLI args to produce the resolved AvatarConfig.
 */
export function resolveAvatarConfig(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): ParsedArgs {
  const cli = parseCliArgs(argv);
  const unknown = argv.filter((a) => {
    if (!a.startsWith("--")) return false;
    const eq = a.indexOf("=");
    const flag = eq > 0 ? a.slice(0, eq) : a;
    return !KNOWN_FLAGS.has(flag);
  });

  const port = resolve(
    "--port",
    "CLAUDE_EMOTE_PORT",
    env,
    cli.port,
    (raw) => {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    },
    DEFAULTS.port,
  );
  const instanceId = resolve(
    "--instance",
    "CLAUDE_EMOTE_INSTANCE_ID",
    env,
    cli.instanceId,
    (raw) => raw || undefined,
    DEFAULTS.instanceId,
  );
  const emoteDir = resolve(
    "--emoteDir",
    "CLAUDE_EMOTE_EMOTE_DIR",
    env,
    cli.emoteDir,
    (raw) => raw || undefined,
    DEFAULTS.emoteDir,
  );
  const parentPid = resolve(
    "--parentPid",
    "CLAUDE_EMOTE_PARENT_PID",
    env,
    cli.parentPid,
    (raw) => {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    },
    DEFAULTS.parentPid,
  );

  return {
    config: { port, instanceId, emoteDir, parentPid },
    unknown,
  };
}