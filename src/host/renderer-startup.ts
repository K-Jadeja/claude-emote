/**
 * renderer-startup.ts
 *
 * Phase 10 / Defect B: one narrow seam that bundles the renderer +
 * host + animator + initial-frame readiness step into a single
 * async attempt. The avatar process can call it twice: once for the
 * preferred renderer, once for the bundled-ASCII fallback when the
 * first attempt fails AND the emote selection is `automatic`.
 *
 * The seam is intentionally tiny so it stays testable:
 *
 *   - All resources created by an attempt are owned by the returned
 *     `AttemptedRuntime`; disposing it is a single call to
 *     `disposeAttemptedRuntime`. Idempotent.
 *   - The factory / renderer / waitForInitialFrame dependencies are
 *     all injected through a typed `RendererStartupDeps` object so
 *     tests can swap them deterministically without touching the
 *     filesystem or a real Chafa dependency.
 *   - The runtime config object passed in by the caller is NOT
 *     mutated; each attempt operates on a shallow clone. The caller's
 *     shared `Config` therefore observes no emotes[] side effects from
 *     failed attempts.
 */

import { AsciiRenderer } from "../core/render_ascii.js";
import { Animator } from "../core/animator.js";
import { StandaloneRenderHost } from "../adapters/standalone-render-host.js";
import {
  createRenderer,
  type RendererFactoryResult,
} from "../adapters/renderer-factory.js";
import type { Config, ResolvedRenderer } from "../core/types.js";
import type { Renderer, RenderedFrame } from "../core/renderer.js";
import type { EmoteSelection } from "../shared/emote-selection.js";

/**
 * Wait for the renderer to produce a usable initial frame.
 * Bounded: at most maxTicks ticks on the macrotask queue. Returns
 * true when a non-null, non-empty frame is available. Never adds a
 * polling interval.
 */
export async function waitForInitialFrame(
  getFrame: () => RenderedFrame | null,
  maxTicks = 10,
): Promise<boolean> {
  for (let i = 0; i < maxTicks; i++) {
    const f = getFrame();
    if (f == null) {
      await new Promise<void>((r) => setImmediate(r));
      continue;
    }
    if (f.kind === "text") {
      if (Array.isArray(f.lines) && f.lines.some((l) => l.length > 0)) {
        return true;
      }
    } else if (f.kind === "image") {
      if (typeof f.sequence === "string" && f.sequence.length > 0) {
        return true;
      }
    } else if (f.kind === "placeholder") {
      if (Array.isArray(f.lines) && f.lines.some((l) => l.length > 0)) {
        return true;
      }
    } else {
      return true;
    }
    await new Promise<void>((r) => setImmediate(r));
  }
  return false;
}

/**
 * Factory for the preferred (image-or-ASCII) renderer.
 */
export type PreferredRendererFactory = (
  config: Config,
  extDir: string,
  emoteSetDir: string,
  userConfiguredTerminals: Set<string>,
) => RendererFactoryResult;

/**
 * Factory for the bundled-ASCII fallback renderer.
 *
 * Separate from the preferred factory so:
 *   - The fallback cannot accidentally re-resolve to a Sixel/image
 *     renderer when the same config is reused.
 *   - Tests can inject a fake preferred factory while still using
 *     the real AsciiRenderer, or vice versa.
 */
export type AsciiRendererFactory = (
  emoteSetDir: string,
  extDir: string,
) => Renderer;

/**
 * Injected dependencies. Production wires up real factories and the
 * real waitForInitialFrame. Tests inject fakes.
 */
export interface RendererStartupDeps {
  preferredRendererFactory: PreferredRendererFactory;
  asciiRendererFactory: AsciiRendererFactory;
  waitForInitialFrame: typeof waitForInitialFrame;
  /** Directory used by the production factories as `extDir`. */
  packageRoot: string;
  /**
   * When set, the attempt builds a renderer via this object directly
   * instead of calling the preferred factory. Used by the ASCII
   * fallback so the failed protocol cannot pull the retry back into
   * a Sixel renderer. Tests typically leave this undefined and
   * instead inject `preferredRendererFactory` so they exercise the
   * full path.
   */
  forceRenderer?: Renderer;
  forceResolved?: ResolvedRenderer;
}

export interface AttemptedRuntime {
  selection: EmoteSelection;
  renderer: Renderer;
  resolved: ResolvedRenderer;
  host: StandaloneRenderHost;
  animator: Animator;
}

export type RendererStartupAttempt =
  | { ok: true; runtime: AttemptedRuntime }
  | { ok: false; reason: string; selection: EmoteSelection; protocol?: string };

/**
 * Run a single renderer/host/animator startup attempt for the given
 * emote selection. Owns:
 *   - cloning the config so failed attempts don't pollute the caller's
 *     shared `Config.emotes`;
 *   - constructing the renderer (via the injected factory);
 *   - constructing + attaching the StandaloneRenderHost;
 *   - constructing the Animator and forcing the initial "idle" state;
 *   - waiting for the renderer to produce a usable initial frame.
 *
 * The returned `AttemptedRuntime` is the only handle the caller needs.
 * On `ok: false` the attempt has already disposed every resource it
 * created; the caller can safely retry or exit.
 */
export async function attemptRendererStartup(opts: {
  config: Config;
  selection: EmoteSelection;
  userConfiguredTerminals: Set<string>;
  deps: RendererStartupDeps;
  /**
   * Renderer-build failure preempts the wait. Used by tests to inject
   * an "image renderer construction failed" scenario without writing
   * a real broken image factory.
   */
  forceBuildFailure?: Error;
}): Promise<RendererStartupAttempt> {
  const { config, selection, userConfiguredTerminals, deps } = opts;

  // Clone the caller's config so each attempt gets a fresh
  // `emotes[]` without mutating the shared object. Emote-set name is
  // derived from the selection so this clone is per-attempt.
  const attemptConfig: Config = {
    ...config,
    emotes: [
      {
        model: "*",
        "emote-set": selection.directory.split(/[\\/]/).pop() ?? "default",
      },
    ],
  };

  let renderer: Renderer;
  let resolved: ResolvedRenderer;
  let setTuiHost: (host: { requestRender: () => void } | null) => void;
  if (opts.forceBuildFailure) {
    return {
      ok: false,
      selection,
      protocol: undefined,
      reason: `renderer construction failed: ${opts.forceBuildFailure.message}`,
    };
  }
  if (deps.forceRenderer !== undefined) {
    renderer = deps.forceRenderer;
    resolved = deps.forceResolved ?? {
      protocol: "ascii",
      multiplexer: null,
      warning: null,
      warningLevel: "warning",
    };
    setTuiHost = (host) => (renderer.setTui as unknown as (t: unknown) => void)(host);
  } else {
    let built: RendererFactoryResult;
    try {
      built = deps.preferredRendererFactory(
        attemptConfig,
        deps.packageRoot,
        selection.directory,
        userConfiguredTerminals,
      );
    } catch (err) {
      return {
        ok: false,
        selection,
        reason: `renderer construction failed: ${(err as Error).message}`,
      };
    }
    renderer = built.renderer;
    resolved = built.resolved;
    setTuiHost = built.setTuiHost;
  }

  const host = new StandaloneRenderHost();
  host.start();
  setTuiHost(host);
  host.attachFrameSource(() => renderer.getRenderedFrame());

  const animator = new Animator(attemptConfig, renderer);
  animator.transitionTo("idle");

  const ready = await deps.waitForInitialFrame(() => renderer.getRenderedFrame());
  if (!ready) {
    try { host.shutdown(); } catch { /* best effort */ }
    try { renderer.dispose(); } catch { /* best effort */ }
    try { animator.clearAllTimers(); } catch { /* best effort */ }
    return {
      ok: false,
      selection,
      protocol: resolved.protocol,
      reason: `preferred ${resolved.protocol} renderer failed to produce an initial frame from ${selection.directory}`,
    };
  }

  return {
    ok: true,
    runtime: { selection, renderer, resolved, host, animator },
  };
}

/**
 * Dispose every resource owned by an `AttemptedRuntime`. Idempotent.
 */
export async function disposeAttemptedRuntime(
  runtime: AttemptedRuntime | null,
): Promise<void> {
  if (!runtime) return;
  const { host, renderer, animator } = runtime;
  try { animator.clearAllTimers(); } catch { /* best effort */ }
  try { renderer.dispose(); } catch { /* best effort */ }
  try { host.shutdown(); } catch { /* best effort */ }
}

/**
 * Build the production dependency bundle. `packageRoot` MUST be the
 * absolute path of the installed claude-emote package root.
 */
export function buildProductionRendererStartupDeps(
  packageRoot: string,
): RendererStartupDeps {
  return {
    preferredRendererFactory: createRenderer,
    asciiRendererFactory: (emoteSetDir, extDir) => {
      const r = new AsciiRenderer();
      r.loadFrames(emoteSetDir, extDir);
      return r;
    },
    waitForInitialFrame,
    packageRoot,
  };
}

/**
 * Validate that the bundled ASCII emote directory is usable as a
 * fallback target. Pure with respect to (deps, asciiDir): always
 * returns the same answer for the same inputs.
 */
export interface AsciiFallbackGate {
  ok: boolean;
  reason?: string;
}

export function validateBundledAsciiDirectory(
  asciiDir: string,
  validate: (
    dir: string,
    kind: "ascii",
  ) => { ok: boolean; reason?: string },
): AsciiFallbackGate {
  const result = validate(asciiDir, "ascii");
  return result.ok
    ? { ok: true }
    : { ok: false, reason: result.reason };
}

/**
 * High-level orchestration: run the preferred renderer attempt, then
 * the bundled-ASCII fallback exactly once when automatic.
 *
 * This function is the single owner of the fallback policy. The
 * caller (`avatar-process.ts`) calls it once and either forwards the
 * returned runtime to the state-controller / READY path or exits with
 * the returned failure. It does NOT duplicate the fallback decision.
 *
 * Policy:
 *
 *   1. Call the preferred startup attempt exactly once.
 *   2. If preferred succeeds, return immediately. ASCII factory is
 *      NOT called. Warning is NOT emitted.
 *   3. If preferred fails AND the selection is `custom`, return the
 *      original failure. ASCII factory is NOT called. Warning is
 *      NOT emitted. (Explicit user intent is never silently
 *      substituted for unrelated bundled artwork.)
 *   4. If preferred fails AND the selection is `automatic`:
 *      a. Validate the bundled ASCII directory. If validation
 *         fails, return the original preferred failure (the caller
 *         can decide whether to surface the validation error).
 *      b. Emit exactly one warning through `onFallbackWarning`.
 *      c. Construct the bundled ASCII renderer exactly once.
 *      d. Retry the startup attempt with the ASCII renderer. Never
 *         a third attempt.
 *
 * The runtime config object passed in by the caller is never
 * mutated; per-attempt cloning happens inside
 * `attemptRendererStartup`.
 */
export interface StartRendererRuntimeOptions {
  config: Config;
  selection: EmoteSelection;
  userConfiguredTerminals: Set<string>;
  deps: RendererStartupDeps;
  /** Bundled ASCII directory to fall back to. */
  bundledAsciiDirectory: string;
  /** Validate an emote directory. The emote-validation helper. */
  validateEmoteDirectory: (
    dir: string,
    kind: "ascii",
  ) => { ok: boolean; reason?: string };
  /** Called exactly once when the ASCII fallback is attempted. */
  onFallbackWarning: (message: string) => void;
}

export type StartRendererRuntimeResult =
  | { ok: true; runtime: AttemptedRuntime }
  | { ok: false; reason: string; selection: EmoteSelection; protocol?: string };

export async function startRendererRuntimeWithFallback(
  opts: StartRendererRuntimeOptions,
): Promise<StartRendererRuntimeResult> {
  const {
    config,
    selection,
    userConfiguredTerminals,
    deps,
    bundledAsciiDirectory,
    validateEmoteDirectory,
    onFallbackWarning,
  } = opts;

  // 1) Preferred attempt (always exactly once).
  const preferred = await attemptRendererStartup({
    config,
    selection,
    userConfiguredTerminals,
    deps,
  });
  if (preferred.ok) {
    return { ok: true, runtime: preferred.runtime };
  }

  // 2) Explicit selection → never fall back.
  if (selection.kind !== "automatic") {
    return {
      ok: false,
      selection: preferred.selection,
      reason: preferred.reason,
      protocol: preferred.protocol,
    };
  }

  // 3) Automatic selection → validate + warn + retry exactly once.
  const gate = validateBundledAsciiDirectory(
    bundledAsciiDirectory,
    validateEmoteDirectory,
  );
  if (!gate.ok) {
    return {
      ok: false,
      selection: preferred.selection,
      reason: preferred.reason,
      protocol: preferred.protocol,
    };
  }

  const failedProtocol = preferred.protocol ?? "unknown";
  onFallbackWarning(
    `[avatar-process] preferred ${failedProtocol} renderer could not produce an initial frame; falling back to bundled ASCII\n`,
  );

  const fallbackSelection: EmoteSelection = {
    kind: "automatic",
    directory: bundledAsciiDirectory,
  };
  const asciiRenderer = deps.asciiRendererFactory(
    fallbackSelection.directory,
    deps.packageRoot,
  );
  const fallback = await attemptRendererStartup({
    config,
    selection: fallbackSelection,
    userConfiguredTerminals,
    deps: {
      ...deps,
      forceRenderer: asciiRenderer,
      forceResolved: {
        protocol: "ascii",
        multiplexer: null,
        warning: null,
        warningLevel: "warning",
      },
    },
  });
  if (fallback.ok) {
    return { ok: true, runtime: fallback.runtime };
  }
  return {
    ok: false,
    selection: fallback.selection,
    reason: fallback.reason,
    protocol: fallback.protocol,
  };
}
