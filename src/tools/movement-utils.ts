// Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
import type { Bot } from 'mineflayer';
import type { goals } from 'mineflayer-pathfinder';
import { allowOpenWoodenDoors } from './open-door-navigation.js';
import { navigationHazard, useDryLandMovements } from '../movement-safety.js';

export const DEFAULT_MOVE_TIMEOUT_MS = 15000;
export const MAX_MOVE_TIMEOUT_MS = 60000;

/** Cancel immediately, then retain the action lane until goto has settled. */
export async function moveAndVerify(bot: Bot, goal: goals.Goal, timeoutMs = DEFAULT_MOVE_TIMEOUT_MS, options: { signal?: AbortSignal } = {}): Promise<void> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_MOVE_TIMEOUT_MS) throw new Error('Movement timeout must be 1..60000ms');
  options.signal?.throwIfAborted();
  const initialHazard = navigationHazard(bot);
  if (initialHazard) throw new Error(initialHazard);
  const restoreDryPolicy = useDryLandMovements(bot);
  let restoreMovements: () => void;
  try { restoreMovements = allowOpenWoodenDoors(bot); }
  catch (error) { restoreDryPolicy(); throw error; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let safetyFailure: Error | undefined;
  let rejectSafety: (error: Error) => void = () => {};
  const safety = new Promise<never>((_, reject) => { rejectSafety = reject; });
  const fail = (message: string) => { safetyFailure ??= new Error(message); rejectSafety(safetyFailure); };
  const check = () => { try { const hazard = navigationHazard(bot); if (hazard) fail(hazard); } catch { fail('Navigation observations became unavailable; controls stopped'); } };
  const ended = () => fail('Session ended or player died during navigation');
  const abort = () => fail('Navigation cancelled');
  bot.on('breath', check); bot.on('physicsTick', check); bot.on('death', ended); bot.on('end', ended);
  options.signal?.addEventListener('abort', abort, { once: true });
  const movement = Promise.resolve().then(() => { options.signal?.throwIfAborted(); if (safetyFailure) throw safetyFailure; return bot.pathfinder.goto(goal); });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Move timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([movement, timeout, safety]);
    if (safetyFailure) throw safetyFailure;
    options.signal?.throwIfAborted();
    const finalHazard = navigationHazard(bot); if (finalHazard) throw new Error(finalHazard);
    const position = bot.entity?.position;
    if (!position || !goal.isEnd(position.floored() as unknown as Parameters<typeof goal.isEnd>[0])) {
      throw new Error('Pathfinder stopped without reaching the requested goal; movement not confirmed');
    }
  } catch (error) {
    // stop() is only a request to stop at a later path node. setGoal(null)
    // synchronously clears the goal and rejects the installed goto listener.
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    await movement.catch(() => undefined);
    if (safetyFailure) throw safetyFailure;
    if (timedOut) throw new Error(`Move timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    bot.removeListener('breath', check); bot.removeListener('physicsTick', check);
    bot.removeListener('death', ended); bot.removeListener('end', ended);
    options.signal?.removeEventListener('abort', abort);
    restoreMovements();
    restoreDryPolicy();
  }
}
