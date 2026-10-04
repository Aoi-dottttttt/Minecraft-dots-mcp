import { describe, it, expect } from "vitest";
import { ActionLocks } from "../src/bot/action-locks.js";

describe("ActionLocks", () => {
  it("tracks the current action and busy state", () => {
    const locks = new ActionLocks();
    expect(locks.isBusy()).toBe(false);
    const h = locks.begin("goto");
    expect(locks.isBusy()).toBe(true);
    expect(locks.current).toBe("goto");
    h.release();
    expect(locks.isBusy()).toBe(false);
    expect(locks.current).toBeNull();
  });

  it("cancels and aborts the prior action when a new one starts", () => {
    const locks = new ActionLocks();
    let cancelledReason: string | null = null;
    const first = locks.begin("dig", (reason) => {
      cancelledReason = reason;
    });
    const second = locks.begin("goto");
    expect(first.signal.aborted).toBe(true);
    expect(cancelledReason).toBe("superseded");
    expect(locks.current).toBe("goto");
    second.release();
  });

  it("cancelAll fires onCancel with the given reason and aborts the signal", () => {
    const locks = new ActionLocks();
    let reason: string | null = null;
    const h = locks.begin("fish", (r) => {
      reason = r;
    });
    expect(locks.cancelAll("manual")).toBe(true);
    expect(reason).toBe("manual");
    expect(h.signal.aborted).toBe(true);
    expect(locks.isBusy()).toBe(false);
    // nothing left to cancel
    expect(locks.cancelAll()).toBe(false);
  });

  it("release after supersession does not clobber the newer action", () => {
    const locks = new ActionLocks();
    const first = locks.begin("a");
    const second = locks.begin("b");
    first.release(); // stale release — must not clear b
    expect(locks.current).toBe("b");
    second.release();
    expect(locks.current).toBeNull();
  });
});
