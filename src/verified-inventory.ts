// Candidate interaction extension: exactSource stages identical stacks to avoid Vanilla left-click merging.
// Modified for 2.1.0-dot.4 release (2026-10-04): preserve valid unrelated inventory additions during equipment swaps.
// Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
import type mineflayer from 'mineflayer';
import { getInventoryAuthority, type ServerItem } from './inventory-authority.js';

export async function equipVerified(bot: mineflayer.Bot, sourceSlot: number, destination: mineflayer.EquipmentDestination, timeoutMs = 5000, options: { exactSource?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  const authority = getInventoryAuthority(bot);
  authority.assertMutationReady();
  options.signal?.throwIfAborted();
  if (!bot.supportFeature('stateIdUsed') || bot.registry.version.version !== 767) throw new Error('Verified equipment changes currently require Java 1.21.1 / protocol 767');
  if (bot.currentWindow || authority.cursor) throw new Error('Close the current container and clear the cursor before equipping');
  const frame = authority.getFrame(0);
  const source = frame.slots[sourceSlot];
  if (!source || !Number.isInteger(sourceSlot) || sourceSlot < 9 || sourceSlot >= 45) throw new Error('Equipment source is not in the authoritative player inventory');
  const targets: Record<string, number> = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 };
  const matchingHotbar = frame.slots.findIndex((item, slot) => slot >= 36 && slot < 45 && authority.same(item, source, false));
  const target = destination === 'hand'
    ? (options.exactSource ? (sourceSlot >= 36 ? sourceSlot : 36 + (bot.quickBarSlot ?? 0)) : (matchingHotbar >= 36 ? matchingHotbar : 36 + (bot.quickBarSlot ?? 0)))
    : targets[destination];
  if (target === undefined) throw new Error('Unsupported equipment destination');
  if (sourceSlot !== target && (options.exactSource || !authority.same(frame.slots[target], source, false))) {
    const before = frame.slots.map(item => item ? { full: authority.identity(item, true), identity: authority.identity(item), count: item.count } : null);
    const oldTarget = frame.slots[target];
    const matchingTarget = authority.same(oldTarget, source, false);
    // Pickup clicks merge matching stacks, even for an explicit exact source.
    // Stage the previous target in ordinary storage, never crafting/armor/offhand.
    // A number-key swap of equal stacks can be invisible to server corrections,
    // so use the existing observable pickup/place path for every matching stack.
    const scratch = matchingTarget ? frame.slots.findIndex((item, slot) => slot >= 9 && slot < 45 && slot !== sourceSlot && slot !== target && item === null && frame.revisions[slot] > 0) : -1;
    if (matchingTarget && scratch < 0) throw new Error('Exact equipment transfer needs one empty inventory storage slot to keep matching stacks separate; free a slot or explicitly select the existing hand stack. No click was sent');
    const tracked = new Map<number, ServerItem | null>([[sourceSlot, source], [target, oldTarget]]);
    if (scratch >= 0) tracked.set(scratch, null);
    let expectedCursor: ServerItem | null = null;
    let submitted = false;
    let windowChanged = false;
    const markWindowChanged = () => { windowChanged = true; };
    const windowEvents = ['open_window', 'open_horse_window', 'close_window', 'respawn'] as const;
    const guard = () => {
      authority.assertMutationReady();
      options.signal?.throwIfAborted();
      if (windowChanged || bot.currentWindow || authority.frames.get(0) !== frame) throw new Error('Container changed during equipment transfer');
    };
    const checkTracked = () => {
      if (!authority.same(authority.cursor, expectedCursor) || [...tracked].some(([slot, item]) => !authority.same(frame.slots[slot], item))) throw new Error('Equipment inventory conservation was not confirmed');
    };
    const click = async (slot: number, afterSlot: ServerItem | null, afterCursor: ServerItem | null, label: string) => {
      guard(); checkTracked();
      const seq = authority.sequence;
      submitted = true;
      try {
        bot._client.write('window_click', { windowId: 0, stateId: frame.stateId, slot, mouseButton: 0, mode: 0, changedSlots: [], cursorItem: authority.raw(authority.cursor) });
        await authority.waitFor(() => {
          guard();
          return frame.revisions[slot] > seq && authority.cursorRevision > seq && authority.same(frame.slots[slot], afterSlot) && authority.same(authority.cursor, afterCursor);
        }, timeoutMs, label, options.signal);
      } catch (error) { authority.block(`Equipment transfer not confirmed (${label}); cursor may hold an item`); throw error; }
      tracked.set(slot, afterSlot); expectedCursor = afterCursor;
      guard(); checkTracked();
    };
    for (const event of windowEvents) bot._client.on(event, markWindowChanged);
    bot.on('windowClose', markWindowChanged);
    try {
      if (scratch >= 0) {
        await click(target, null, oldTarget, 'pick up previous equipment');
        await click(scratch, oldTarget, null, 'stage previous equipment');
      }
      await click(sourceSlot, null, source, 'pick up equipment');
      await click(target, source, scratch >= 0 ? null : oldTarget, 'place equipment');
      if (scratch >= 0) await click(scratch, null, oldTarget, 'retrieve previous equipment');
      if (oldTarget) await click(sourceSlot, oldTarget, null, 'return previous equipment');
    } catch (error) {
      if (submitted) authority.block('Equipment transfer was interrupted; inspect inventory and cursor before further actions');
      throw error;
    } finally {
      for (const event of windowEvents) bot._client.removeListener(event, markWindowChanged);
      bot.removeListener('windowClose', markWindowChanged);
    }
    const conserved = frame.slots.every((item, slot) => {
      if (slot === sourceSlot || slot === target) return true; // Exact swap is checked below.
      const previous = before[slot];
      if ((item ? authority.identity(item, true) : null) === (previous?.full ?? null)) return true;
      // The server can deliver ordinary pickups during the swap. Only additive
      // changes in unrelated storage slots are safe; never excuse a loss or replacement.
      if (slot < 9 || slot >= 45 || !item || !Number.isInteger(item.type) || !bot.registry.items[item.type] || !Number.isInteger(item.stackSize) || item.stackSize < 1 || !Number.isInteger(item.count) || item.count < 1 || item.count > item.stackSize) return false;
      return previous === null || (authority.identity(item) === previous.identity && item.count >= previous.count);
    });
    if (authority.cursor || !authority.same(frame.slots[target], source) || !authority.same(frame.slots[sourceSlot], oldTarget) || (scratch >= 0 && frame.slots[scratch] !== null) || !conserved) { authority.block('Equipment inventory conservation was not confirmed'); throw new Error('Equipment inventory conservation was not confirmed'); }
  }
  if (destination === 'hand') {
    authority.assertMutationReady();
    options.signal?.throwIfAborted();
    // The protocol has no acknowledgement of a client-selected hotbar slot. Report it honestly.
    bot.setQuickBarSlot(target - 36);
    if (bot.quickBarSlot !== target - 36) throw new Error('Hotbar selection did not take effect locally');
  }
}

export function chooseExactItem(items: Array<ServerItem & { slot: number }>, query: string): ServerItem & { slot: number } | undefined {
  const name = query.trim().toLowerCase();
  const exact = items.find(item => item.name === name);
  if (exact) return exact;
  const matches = items.filter(item => item.name.includes(name));
  if (new Set(matches.map(item => item.name)).size > 1) throw new Error(`Ambiguous item '${query}'; use an exact item name`);
  return matches[0];
}
