import type { Bot } from 'mineflayer';
import { getInventoryAuthority, type ServerItem } from './inventory-authority.js';

export type ConsumptionOptions = { timeoutMs?: number; signal?: AbortSignal; offHand?: boolean; selectedSlot?: number };
export type ConsumptionSnapshot = { sequence: number; slots: Array<ServerItem | null> };
const remainders: Record<string, string> = {
  mushroom_stew: 'bowl', rabbit_stew: 'bowl', beetroot_soup: 'bowl', suspicious_stew: 'bowl',
  potion: 'glass_bottle', honey_bottle: 'glass_bottle', milk_bucket: 'bucket'
};
const confirmationTimeout = (options: ConsumptionOptions) => {
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new Error('Consumption timeoutMs must be between 1 and 10000');
  return timeoutMs;
};

/** Capture server truth before use (or before auto-eat equips its chosen food). */
export function snapshotConsumption(bot: Bot): ConsumptionSnapshot {
  const authority = getInventoryAuthority(bot);
  authority.assertMutationReady();
  if (bot.currentWindow || authority.cursor) throw new Error('Close containers and clear the cursor before consuming');
  return { sequence: authority.sequence, slots: [...authority.getFrame(0).slots] };
}

/** Hunger and entity_status 9 may arrive before the actual inventory removal.
 * Only a fresh selected-slot update AND an exact item loss complete this barrier.
 * The caller owns failure fencing and item-use cleanup. */
export async function confirmConsumption(bot: Bot, before: ConsumptionSnapshot, item: ServerItem, options: ConsumptionOptions = {}): Promise<void> {
  const authority = getInventoryAuthority(bot);
  const timeoutMs = confirmationTimeout(options);
  if (!item || !Number.isInteger(item.type)) throw new Error('No authoritative selected consumable');
  const slot = options.selectedSlot ?? (options.offHand ? 45 : 36 + bot.quickBarSlot);
  const count = (slots: Array<ServerItem | null>) => slots.reduce((sum, candidate, index) =>
    sum + (index >= 9 && index <= 45 && candidate && authority.same(candidate, item, false) ? candidate.count : 0), 0);
  const beforeCount = count(before.slots);
  if (beforeCount < 1) throw new Error('Selected consumable was not present in the authoritative starting inventory');
  // Auto-eat can equip before calling this barrier. A matching stack already in
  // the selected destination is retained by equipVerified; otherwise it is moved.
  const previous = authority.same(before.slots[slot], item, false) ? before.slots[slot]! : item;
  const confirmed = () => {
    options.signal?.throwIfAborted();
    authority.assertMutationReady();
    if (bot.currentWindow || authority.cursor) throw new Error('Inventory context changed during consumption');
    const frame = authority.getFrame(0);
    const held = frame.slots[slot];
    const selectedChanged = previous.count > 1
      ? authority.same(held, item, false) && held?.count === previous.count - 1
      : held === null || (held?.name === remainders[item.name] && held?.count === 1);
    return (options.offHand || 36 + bot.quickBarSlot === slot) && frame.revisions[slot] > before.sequence &&
      selectedChanged && count(frame.slots) === beforeCount - 1;
  };
  if (confirmed()) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      authority.removeListener('change', check);
      options.signal?.removeEventListener('abort', check);
      error ? reject(error) : resolve();
    };
    const check = () => { try { if (confirmed()) finish(); } catch (error) { finish(error); } };
    const timer = setTimeout(() => finish(new Error('Server confirmation timed out: selected consumable inventory removal')), timeoutMs);
    authority.on('change', check);
    options.signal?.addEventListener('abort', check, { once: true });
    check();
  });
}

/** Exactly one native use. Await its settlement, then server inventory truth;
 * never race and leave an untracked native action behind the serial lane. */
export async function consumeOnceVerified(bot: Bot, consume: () => Promise<unknown>, options: ConsumptionOptions = {}): Promise<{ confirmed: true; item: string; consumed: 1 }> {
  options.signal?.throwIfAborted();
  confirmationTimeout(options);
  const authority = getInventoryAuthority(bot);
  const before = snapshotConsumption(bot);
  const slot = options.offHand ? 45 : 36 + bot.quickBarSlot;
  const item = before.slots[slot];
  if (!item) throw new Error('No authoritative held consumable');
  let cleanupFailed = false, cleanupError: unknown;
  try {
    await consume();
    await confirmConsumption(bot, before, item, { ...options, selectedSlot: slot });
  } catch (error) {
    authority.block('Consumption outcome was not confirmed; do not repeat automatically');
    throw error;
  } finally {
    // Mineflayer's release is synchronous and sends no second use request.
    try { bot.deactivateItem(); }
    catch (error) { authority.block('Consumable item-use cleanup failed; do not repeat automatically'); cleanupFailed = true; cleanupError = error; }
  }
  if (cleanupFailed) throw cleanupError;
  return { confirmed: true, item: item.name, consumed: 1 };
}
