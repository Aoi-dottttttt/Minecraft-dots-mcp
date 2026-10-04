/** Small async helpers. */

import { ToolError } from "./errors.js";

/**
 * Race a promise against a timeout. On timeout the returned promise rejects with
 * a TIMEOUT ToolError. Note: the underlying work is NOT aborted (most mineflayer
 * calls have no abort) — callers that hold a lock should run this INSIDE their
 * try/finally so the lock is released when the timeout fires.
 */
export function withTimeout<T>(p: Promise<T> | T, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new ToolError(
          "TIMEOUT",
          `${label} did not complete within ${ms}ms. It may still be in progress on the server; check get_state / get_events.`,
        ),
      );
    }, ms);
    Promise.resolve(p).then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
