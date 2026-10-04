// Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
import type { Bot } from 'mineflayer';
import type { goals } from 'mineflayer-pathfinder';

export const DEFAULT_MOVE_TIMEOUT_MS = 15000;
export const MAX_MOVE_TIMEOUT_MS = 60000;

/** Cancel immediately, then retain the action lane until goto has settled. */
export async function moveAndVerify(bot: Bot, goal: goals.Goal, timeoutMs = DEFAULT_MOVE_TIMEOUT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const movement = Promise.resolve().then(() => bot.pathfinder.goto(goal));
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Move timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([movement, timeout]);
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
    if (timedOut) throw new Error(`Move timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
