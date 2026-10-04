/**
 * Mutual exclusion + cancellation for long-running, conflicting bot actions
 * (goto, dig, collect_block, pvp_attack, fish, smelt_item, craft_item).
 *
 * Starting a new exclusive action cancels the previous one cleanly: the prior
 * action's `onCancel` runs (e.g. `bot.pathfinder.stop()`) and its AbortSignal
 * fires so any in-flight `await` can bail out.
 */

export type CancelReason = "superseded" | "manual" | "shutdown";

export class CancelledError extends Error {
  readonly reason: CancelReason;
  constructor(reason: CancelReason) {
    super(`Action cancelled (${reason})`);
    this.name = "CancelledError";
    this.reason = reason;
  }
}

interface ActiveAction {
  name: string;
  cancel: (reason: CancelReason) => void;
}

export interface ActionHandle {
  /** Aborts when this action is superseded/cancelled. */
  signal: AbortSignal;
  /** Call when the action finishes (success or failure) to release the lock. */
  release: () => void;
}

export class ActionLocks {
  private active: ActiveAction | null = null;

  get current(): string | null {
    return this.active?.name ?? null;
  }

  isBusy(): boolean {
    return this.active !== null;
  }

  /**
   * Acquire the exclusive action lock, cancelling any prior holder.
   * @param name  Human label for diagnostics / errors.
   * @param onCancel  Best-effort cleanup invoked if this action is cancelled.
   */
  begin(name: string, onCancel?: (reason: CancelReason) => void): ActionHandle {
    this.cancelAll("superseded");
    const controller = new AbortController();
    const entry: ActiveAction = {
      name,
      cancel: (reason) => {
        try {
          onCancel?.(reason);
        } finally {
          controller.abort(new CancelledError(reason));
        }
      },
    };
    this.active = entry;
    return {
      signal: controller.signal,
      release: () => {
        if (this.active === entry) this.active = null;
      },
    };
  }

  /** Cancel the current exclusive action, if any. Returns true if one was cancelled. */
  cancelAll(reason: CancelReason = "manual"): boolean {
    const a = this.active;
    if (!a) return false;
    this.active = null;
    a.cancel(reason);
    return true;
  }
}
