import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { inventoryFixture } from './inventory-fixture.js';
const require = createRequire(import.meta.url);
type Item = { name: string; type: number; count: number; stackSize: number };
export function windowFixture(type = 'minecraft:generic_9x3', menuSlots = 27, initial: Array<{ name: string; count: number; slot: number }> = [{ name: 'coal', count: 4, slot: 9 }, { name: 'cobblestone', count: 64, slot: 10 }]) {
  const base = inventoryFixture(initial);
  const ItemClass = require('prismarine-item')(base.bot.registry);
  const item = (name: string, count: number): Item => new ItemClass(base.bot.registry.itemsByName[name].id, count);
  const copy = (value: Item | null): Item | null => ItemClass.fromNotch(ItemClass.toNotch(value));
  const slots: Array<Item | null> = Array(menuSlots + 36).fill(null);
  for (const value of initial) slots[menuSlots + value.slot - 9] = item(value.name, value.count);
  let cursor: Item | null = null; let state = 1;
  const native = Object.assign(new EventEmitter(), { id: 7, type, inventoryStart: menuSlots, inventoryEnd: menuSlots + 36, slots: slots.map(copy), selectedItem: null, updateSlot() {} }) as unknown as NonNullable<Bot['currentWindow']>;
  const writes: Array<{ name: string; packet: Record<string, number | unknown> }> = [];
  const sync = () => base.bot._client.emit('window_items', { windowId: native.id, stateId: state++, items: slots.map(value => ItemClass.toNotch(value)), carriedItem: ItemClass.toNotch(cursor) });
  const settings = { reject: false, optimisticOnly: false, refillOutput: false, onClick: (_slot: number) => { void _slot; } };
  base.bot.entity = { position: new Vec3(0, 0, 0) } as Bot['entity'];
  const blockNames: Record<string, string> = { 'minecraft:furnace': 'furnace', 'minecraft:blast_furnace': 'blast_furnace', 'minecraft:smoker': 'smoker', 'minecraft:smithing': 'smithing_table', 'minecraft:stonecutter': 'stonecutter', 'minecraft:anvil': 'anvil', 'minecraft:enchantment': 'enchanting_table', 'minecraft:crafting': 'crafting_table', 'minecraft:shulker_box': 'shulker_box', 'minecraft:generic_3x3': 'dispenser', 'minecraft:hopper': 'hopper' };
  base.bot.blockAt = (() => ({ name: blockNames[type] ?? 'chest', position: new Vec3(0, 0, 0) })) as unknown as Bot['blockAt'];
  base.bot.canSeeBlock = () => true;
  const open = () => { base.bot.currentWindow = native; base.bot._client.emit('open_window', { windowId: native.id }); sync(); };
  base.bot.activateBlock = async () => { open(); };
  base.bot.activateEntity = async () => { open(); };
  base.bot.closeWindow = async () => { base.bot.currentWindow = null; base.bot.emit('windowClose', native); };
  base.bot._client.write = ((name: string, raw: unknown) => {
    const packet = raw as { stateId: number; slot: number; mouseButton: number; windowId: number };
    writes.push({ name, packet });
    if (name !== 'window_click') return;
    if (packet.stateId !== state - 1) throw new Error('Incorrect per-window state ID');
    const old = slots[packet.slot];
    if (!settings.reject) {
      if (packet.slot === -999) cursor = null;
      else if (!cursor) {
        if (old) {
          const take = packet.mouseButton === 0 ? old.count : Math.ceil(old.count / 2);
          cursor = { ...copy(old)!, count: take };
          slots[packet.slot] = old.count === take ? null : { ...copy(old)!, count: old.count - take };
          if (settings.refillOutput && packet.slot === 2) slots[2] = copy(old);
        }
      } else if (!old || old.type === cursor.type) {
        const put = Math.min(packet.mouseButton === 0 ? cursor.count : 1, cursor.stackSize - (old?.count ?? 0));
        slots[packet.slot] = { ...copy(cursor)!, count: (old?.count ?? 0) + put };
        cursor = cursor.count === put ? null : { ...copy(cursor)!, count: cursor.count - put };
      } else { slots[packet.slot] = cursor; cursor = old; }
    }
    settings.onClick(packet.slot);
    if (!settings.optimisticOnly) sync();
  }) as Bot['_client']['write'];
  return { ...base, slots, item, native, writes, sync, open, settings, setCursor: (value: Item | null) => { cursor = value; }, getCursor: () => cursor };
}
