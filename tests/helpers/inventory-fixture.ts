// Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';
import { installInventoryAuthority } from '../../src/inventory-authority.js';
const require = createRequire(import.meta.url);
export function inventoryFixture(items: Array<{ name: string; count: number; slot: number }>, reject = false) {
  const registry = require('prismarine-registry')('1.21.1');
  const Item = require('prismarine-item')(registry);
  const slots = Array(46).fill(null);
  for (const item of items) slots[item.slot] = new Item(registry.itemsByName[item.name].id, item.count);
  const client = Object.assign(new EventEmitter(), { write: (_name: string, _packet: unknown) => { void _name; void _packet; } });
  const bot = Object.assign(new EventEmitter(), {
    _client: client, registry, version: '1.21.1', supportFeature: () => true, currentWindow: null, quickBarSlot: 0,
    inventory: { slots: [...slots], items: () => slots.filter(Boolean), selectedItem: null, updateSlot(slot: number, item: unknown) { this.slots[slot] = item; } },
    setQuickBarSlot(slot: number) { this.quickBarSlot = slot; }
  }) as unknown as Bot;
  const authority = installInventoryAuthority(bot);
  let state = 1;
  let cursor: typeof slots[number] = null;
  const sync = () => client.emit('window_items', { windowId: 0, stateId: state, items: slots.map(i => Item.toNotch(i)), carriedItem: Item.toNotch(cursor) });
  const writes: unknown[] = [];
  client.write = (_name, packet) => {
    const click = packet as { stateId: number; slot: number; mode: number; mouseButton: number };
    if (click.stateId !== state) throw new Error('Incorrect state ID');
    if (_name !== 'window_click' || click.mode !== 0 || click.mouseButton !== 0 || click.slot < 0 || click.slot >= slots.length) throw new Error('Unsupported fixture click');
    writes.push(packet);
    if (!reject) {
      const old = slots[click.slot];
      // Vanilla pickup clicks merge matching identities up to their stack cap;
      // a full matching target leaves the cursor unchanged, never swaps stacks.
      if (old && cursor && authority.same(old, cursor, false)) {
        const moved = Math.max(0, Math.min(cursor.count, Math.min(old.stackSize, cursor.stackSize) - old.count));
        old.count += moved;
        cursor.count -= moved;
        if (cursor.count === 0) cursor = null;
      } else { slots[click.slot] = cursor; cursor = old; }
      state++;
    }
    sync();
  };
  sync();
  return { bot, authority, slots, writes, sync };
}
