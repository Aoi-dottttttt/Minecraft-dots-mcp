// Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
import type { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import { interruptible, type InterruptibleOptions } from '../action-interruption.js';
import type { goals } from 'mineflayer-pathfinder';
import { allowOpenWoodenDoors } from './open-door-navigation.js';
import { navigationHazard, useDryLandMovements } from '../movement-safety.js';
import { getOxygenAuthority } from '../oxygen-authority.js';

export const DEFAULT_MOVE_TIMEOUT_MS = 15000;
export const MAX_MOVE_TIMEOUT_MS = 60000;

// Match the pinned pathfinder's partial-block start-node normalization, but
// only accept a raised grid position when collision geometry supports the feet.
// An already-satisfied A* search returns an empty path without goal_reached.
function supportedPlanningPosition(bot: Bot): Vec3 | null {
  const position = bot.entity.position;
  if (bot.entity.onGround !== true || ![position.x, position.y, position.z].every(Number.isFinite)) return null;
  const grid = position.floored();
  if (position.y - grid.y <= 0.001) return null;
  const block = bot.blockAt(grid, false);
  const emptyBlocks = bot.pathfinder.movements?.emptyBlocks;
  if (!block || !block.position.equals(grid) || !emptyBlocks || emptyBlocks.has(block.type)) return null;
  if (!Array.isArray(block.shapes) || block.shapes.length === 0) return null;

  // prismarine-physics uses a 0.6-wide player AABB. This epsilon handles only
  // collision-contact roundoff, never goal distance or a missing support block.
  const halfWidth = 0.3;
  const epsilon = 1e-7;
  let supported = false;
  for (const shape of block.shapes) {
    if (!Array.isArray(shape) || shape.length !== 6 || !Array.from(shape).every(Number.isFinite) ||
        shape[0] >= shape[3] || shape[1] >= shape[4] || shape[2] >= shape[5]) return null;
    const overlaps = position.x + halfWidth > grid.x + shape[0] + epsilon &&
      position.x - halfWidth < grid.x + shape[3] - epsilon &&
      position.z + halfWidth > grid.z + shape[2] + epsilon &&
      position.z - halfWidth < grid.z + shape[5] - epsilon;
    if (!overlaps) continue;
    const top = grid.y + shape[4];
    // A stair's upper riser must not intersect the player at its lower tread.
    if (top > position.y + epsilon && grid.y + shape[1] < position.y + 1.8) return null;
    if (Math.abs(top - position.y) <= epsilon) supported = true;
  }
  return supported ? grid.offset(0, 1, 0) : null;
}


/** Cancel immediately, then retain the action lane until goto has settled. */
export async function moveAndVerify(bot: Bot, goal: goals.Goal, timeoutMs = DEFAULT_MOVE_TIMEOUT_MS, options: InterruptibleOptions = {}): Promise<void> {
  return interruptible(options, () => moveInternal(bot, goal, timeoutMs, options));
}
async function moveInternal(bot: Bot, goal: goals.Goal, timeoutMs: number, options: InterruptibleOptions): Promise<void> {
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
  const oxygen = getOxygenAuthority(bot);
  oxygen?.on('change', check); bot.on('physicsTick', check); bot.on('death', ended); bot.on('end', ended);
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
    const physicalGridReached = position && goal.isEnd(position.floored() as unknown as Parameters<typeof goal.isEnd>[0]);
    const supportedGrid = position && !physicalGridReached ? supportedPlanningPosition(bot) : null;
    const supportedGridReached = supportedGrid && goal.isEnd(supportedGrid as unknown as Parameters<typeof goal.isEnd>[0]);
    if (!physicalGridReached && !supportedGridReached) {
      throw new Error('Pathfinder stopped without reaching the requested goal; movement not confirmed');
    }
    // Empty-path success leaves the goal installed. Retire only this operation's
    // accepted goal before restoring movements, without clearing a newer goal.
    if (supportedGridReached && bot.pathfinder.goal === goal) {
      bot.pathfinder.setGoal(null);
      bot.clearControlStates();
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
    oxygen?.removeListener('change', check); bot.removeListener('physicsTick', check);
    bot.removeListener('death', ended); bot.removeListener('end', ended);
    options.signal?.removeEventListener('abort', abort);
    restoreMovements();
    restoreDryPolicy();
  }
}
