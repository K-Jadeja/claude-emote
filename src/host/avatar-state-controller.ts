/**
 * avatar-state-controller.ts
 *
 * Phase 7 — the single small owner of avatar-state priority.
 *
 * Between mapEventSafe() (declarative hook → AvatarReaction) and the
 * copied pi-emote Animator (state machine + timers), the controller
 * decides:
 *
 *   - Whether the reaction's state is allowed to replace the current
 *     visible state.
 *   - Whether the reaction's talk token (if any) is forwarded to
 *     Animator.onTalkToken().
 *   - Whether to set the Animator's holdNextState before entering a
 *     failure hold so the failure transitions to "think" instead of
 *     the default "idle".
 *
 * Priority rules (authoritative, mirrors docs/STATE_MACHINE.md):
 *
 *   1. Compact lock. Once PreCompact enters compact, only PostCompact,
 *      Stop, or shutdown can leave it. Ordinary events are blocked
 *      visually but talk tokens are still forwarded to onTalkToken()
 *      (or silently dropped — see choice below).
 *
 *   2. Failure hold. Failure remains visible for the configured
 *      holdDuration.failure. During the hold, think/talk/read/write/
 *      tool/idle/hi cannot visibly replace it. After the hold,
 *      Animator.transitionTo("think") runs (because we set
 *      holdNextState="think" before entering failure).
 *
 *   3. Compact outranks failure. If a compact arrives during a
 *      failure hold, the Animator's own clearStateTimers() cancels
 *      the failure continuation — no stale continuation can win.
 *
 *   4. Talk token accounting is independent of visible state. A
 *      MessageDisplay that arrives during failure still forwards its
 *      delta to Animator.onTalkToken() exactly once. The visible
 *      state remains failure; the Animator's existing token logic
 *      ignores subsequent tokens while not in "talk" mode, but we
 *      still forward them so the Animator's mouth math is accurate
 *      when failure ends and talk resumes.
 *
 *   5. Shutdown is terminal. SessionEnd (or any reaction with
 *      shutdown: true) invokes the controller's shutdown callback
 *      and blocks all subsequent state changes.
 *
 * No controller-owned timer system is added. Stale-continuation
 * prevention relies on the Animator's own transitionTo() which
 * clears all state timers on every call.
 *
 * The Animator is authoritative for the current visible state because
 * it owns timed transitions. The controller synchronizes its priority
 * snapshot from the Animator before making each decision.
 */

import type { EmoteState } from "../core/types.js";
import type { AvatarReaction } from "../claude/event-mapper.js";

/** Minimal Animator port the controller depends on. */
export interface AvatarAnimatorPort {
  transitionTo(state: EmoteState): void;
  onTalkToken(token: string): void;
  /** Authoritative state, including transitions fired by Animator timers. */
  getCurrentState(): EmoteState;
  /** Optional: the copied Animator exposes this for failure-to-think. */
  setHoldNextState?(state: EmoteState): void;
}

export interface AvatarStateControllerOptions {
  animator: AvatarAnimatorPort;
  /**
   * Called once when a reaction carries shutdown: true. The avatar
   * process wires this to its existing shutdown path.
   */
  onShutdown: () => void;
}

export interface AvatarStateController {
  /**
   * Apply a mapped reaction to the avatar state machine.
   */
  handle(reaction: AvatarReaction): void;
  /**
   * Idempotent. After shutdown, handle() is a no-op.
   */
  shutdown(): void;
  /**
   * The currently visible state. Timed Animator transitions are
   * synchronized before this value is returned.
   */
  getVisibleState(): EmoteState | null;
}

/** States that can replace each other freely. */
const ORDINARY_STATES: ReadonlySet<EmoteState> = new Set<EmoteState>([
  "hi",
  "idle",
  "think",
  "talk",
  "read",
  "write",
  "tool",
  "success",
]);

export function createAvatarStateController(
  opts: AvatarStateControllerOptions,
): AvatarStateController {
  const { animator, onShutdown } = opts;
  let visibleState: EmoteState | null = null;
  let isShutdown = false;

  /**
   * The Animator owns hold/talk timers and can transition without a new hook.
   * Keep the controller's priority snapshot aligned at decision boundaries
   * rather than introducing a second timer system.
   *
   * Preserve the initial null value until this controller has handled its
   * first reaction. Startup establishes Animator idle before construction,
   * while null remains useful to callers as "no hook state observed yet".
   */
  function syncVisibleState(): void {
    if (visibleState === null) return;
    visibleState = animator.getCurrentState();
  }

  function isCompactLocked(): boolean {
    syncVisibleState();
    return visibleState === "compact";
  }

  function isFailureHeld(): boolean {
    syncVisibleState();
    return visibleState === "failure";
  }

  function shouldSuppress(reaction: AvatarReaction): boolean {
    if (!reaction.state) return true; // null state — no-op
    if (isCompactLocked()) {
      // Idle is the release signal from PostCompact / Stop. Any
      // other state must not replace compact visually.
      return reaction.state !== "idle";
    }
    if (isFailureHeld()) {
      // Failure is held for the configured holdDuration. Ordinary
      // states must not visibly replace it. Compact CAN replace it
      // (compact outranks failure per the spec).
      if (reaction.state === "compact") return false;
      if (ORDINARY_STATES.has(reaction.state)) return true;
      return false;
    }
    return false;
  }

  function handle(reaction: AvatarReaction): void {
    if (isShutdown) return;

    // 1. Shutdown always wins.
    if (reaction.shutdown) {
      isShutdown = true;
      try {
        onShutdown();
      } catch {
        // swallow — shutdown must be safe to invoke from any state.
      }
      return;
    }

    // 2. Talk-token forwarding. Independent of visible state, but
    //    dropped after shutdown.
    if (
      typeof reaction.talkToken === "string" &&
      reaction.talkToken.length > 0
    ) {
      animator.onTalkToken(reaction.talkToken);
    }

    // 3. State suppression.
    if (shouldSuppress(reaction)) {
      return;
    }

    const target = reaction.state;
    if (!target) return;

    // 4. Failure → think transition via the Animator's existing
    //    holdNextState mechanism. The Animator's
    //    transitionTo("failure") reads holdNextState before its own
    //    clearStateTimers() runs, then resets it to "idle". We set
    //    it to "think" first.
    if (target === "failure" && animator.setHoldNextState) {
      animator.setHoldNextState("think");
    }

    animator.transitionTo(target);
    visibleState = target;
  }

  function shutdown(): void {
    isShutdown = true;
    // visibleState is intentionally preserved so a late handle() that
    // somehow runs before isShutdown is checked still has context.
  }

  return {
    handle,
    shutdown,
    getVisibleState: () => {
      syncVisibleState();
      return visibleState;
    },
  };
}

// Re-export the state set so tests can assert against it without
// re-defining membership.
export const ORDINARY_STATE_SET = ORDINARY_STATES;
