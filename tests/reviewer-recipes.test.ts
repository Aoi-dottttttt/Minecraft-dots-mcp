// Modified for 2.1.0-dot.4 release (2026-10-04): preserve valid unrelated inventory additions during equipment swaps.
// Modified for 2.1.0-dot.3 release (2026-10-04): protocol 767 unsigned container IDs.
// Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
import test from 'ava';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import { installInventoryAuthority } from '../src/inventory-authority.js';
import { craftVerified, type VerifiedRecipe } from '../src/verified-crafting.js';
import { equipVerified } from '../src/verified-inventory.js';

const require = createRequire(import.meta.url);
const { createSerializer, createDeserializer } = require('minecraft-protocol');
const wireEncoder = createSerializer({ state: 'play', isServer: true, version: '1.21.1' });
const wireDecoder = createDeserializer({ state: 'play', isServer: false, version: '1.21.1' });
const registry = require('prismarine-registry')('1.21.1');
const Item = require('prismarine-item')(registry);
const id = (name: string): number => registry.itemsByName[name].id;
const stack = (name: string, count = 1) => new Item(id(name), count);
type FakeItem = { type: number; count: number } | null;
type Packet = { windowId: number; slot: number; stateId: number; mouseButton: number };

function recipeServer(options: {
  table?: boolean;
  layout: Record<number, string>;
  output: string;
  outputCount: number;
  initial: Record<number, [string, number]>;
  remainders?: Record<number, string>;
  omitRemainder?: boolean;
  corruptUnrelated?: boolean;
  wireFragments?: boolean;
  duringClick?: (slots: FakeItem[], clickNumber: number) => void;
}) {
  const client = new EventEmitter() as EventEmitter & { write: (name: string, packet: Packet) => void };
  const emitter = new EventEmitter();
  const player: FakeItem[] = Array(46).fill(null);
  for (const [slot, [name, count]] of Object.entries(options.initial)) player[Number(slot)] = stack(name, count);
  let slots = player;
  let windowId = 0;
  let state = 112;
  let cursor: FakeItem = null;
  const writes: Packet[] = [];
  let closed = 0;
  const bot = Object.assign(emitter, {
    version: '1.21.1', _client: client, registry,
    supportFeature: (name: string) => name === 'stateIdUsed',
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: () => ({ name: 'crafting_table', position: new Vec3(1, 64, 0) }),
    canSeeBlock: () => true,
    getControlState: () => false,
    inventory: { slots: player, selectedItem: null, updateSlot: () => undefined },
    currentWindow: null,
    quickBarSlot: 0,
    setQuickBarSlot(slot: number) { this.quickBarSlot = slot; },
    activateBlock: async () => {
      slots = [...Array(10).fill(null), ...player.slice(9, 45)];
      windowId = 31;
      state = 700;
      bot.currentWindow = { id: windowId, type: 'minecraft:crafting', inventoryStart: 10, inventoryEnd: 46, slots, selectedItem: null } as Bot['currentWindow'];
      client.emit('open_window', { windowId });
      sync();
    },
    closeWindow: () => { closed++; bot.currentWindow = null; client.emit('close_window', { windowId }); }
  }) as unknown as Bot;
  const authority = installInventoryAuthority(bot);
  const sync = () => client.emit('window_items', { windowId, stateId: state, items: slots.map(i => Item.toNotch(i)), carriedItem: Item.toNotch(cursor) });
  sync();
  client.write = (name, p) => {
    if (name !== 'window_click') throw new Error(`Unexpected packet ${name}`);
    if (p.windowId !== windowId || p.stateId !== state) throw new Error('Incorrect window ID or state ID');
    writes.push(p);
    const previous = slots.map(i => Item.toNotch(i));
    const cell = slots[p.slot];
    if (p.slot === 0) {
      cursor = cell;
      slots[0] = null;
      for (const slot of Object.keys(options.layout)) slots[Number(slot)] = null;
      for (const [slot, name] of Object.entries(options.remainders ?? {})) {
        if (!options.omitRemainder) slots[Number(slot)] = stack(name);
      }
      if (options.corruptUnrelated) slots[windowId ? 12 : 11] = null;
    } else if (!cursor) {
      cursor = cell;
      slots[p.slot] = null;
    } else if (p.mouseButton === 1) {
      if (cell && cell.type !== cursor.type) throw new Error('Fixture received unsupported right-click swap');
      slots[p.slot] = new Item(cursor.type, (cell?.count ?? 0) + 1);
      cursor = cursor.count > 1 ? new Item(cursor.type, cursor.count - 1) : null;
    } else if (!cell || (cell.type === cursor.type && cell.count + cursor.count <= registry.items[cell.type].stackSize)) {
      slots[p.slot] = new Item(cursor.type, (cell?.count ?? 0) + cursor.count);
      cursor = null;
    } else {
      slots[p.slot] = cursor;
      cursor = cell;
    }
    const gridEnd = options.table ? 9 : 4;
    if (p.slot >= 1 && p.slot <= gridEnd) {
      const ready = Object.entries(options.layout).every(([slot, name]) => slots[Number(slot)]?.type === id(name)) && Object.keys(options.layout).length > 0;
      slots[0] = ready ? stack(options.output, options.outputCount) : null;
    }
    options.duringClick?.(slots, writes.length);
    state++;
    if (options.wireFragments) {
      const emitWire = (params: unknown) => {
        const bytes = wireEncoder.createPacketBuffer({ name: 'set_slot', params });
        const decoded = wireDecoder.parsePacketBuffer(bytes).data;
        client.emit(decoded.name, decoded.params);
      };
      for (let slot = 0; slot < slots.length; slot++) {
        const item = Item.toNotch(slots[slot]);
        if (JSON.stringify(item) !== JSON.stringify(previous[slot])) emitWire({ windowId, stateId: state, slot, item });
      }
      emitWire({ windowId: 255, stateId: state, slot: -1, item: Item.toNotch(cursor) });
    } else sync();
  };
  const table = options.table ? { position: new Vec3(1, 64, 0) } as Parameters<Bot['craft']>[2] : undefined;
  return { bot, authority, writes, player, table, sync, getClosed: () => closed };
}

test('protocol 767: binary unsigned cursor corrections confirm the synthetic birch slab recipe', async t => {
  const s = recipeServer({ table: true, wireFragments: true, layout: { 1: 'birch_planks', 2: 'birch_planks', 3: 'birch_planks' }, output: 'birch_slab', outputCount: 6, initial: { 19: ['birch_planks', 11], 20: ['birch_slab', 6] } });
  const recipe: VerifiedRecipe = { requiresTable: true, result: { id: id('birch_slab'), count: 6 }, inShape: [[{ id: id('birch_planks') }, { id: id('birch_planks') }, { id: id('birch_planks') }]] };
  const result = await craftVerified(s.bot, recipe, s.table, 20);
  t.is(result.outputCount, 6);
  t.is(s.authority.count(id('birch_planks')), 8);
  t.is(s.authority.count(id('birch_slab')), 12);
  t.is(s.authority.cursor, null);
  t.is(s.authority.fence, null);
  t.false(s.authority.frames.has(255));
  t.is(s.getClosed(), 1);
});

test('protocol 767: binary 254 inventory corrections map special slots without phantom windows', t => {
  const s = recipeServer({ layout: {}, output: 'birch_slab', outputCount: 6, initial: {} });
  for (const [slot, expected] of [[0, 36], [8, 44], [36, 8], [39, 5], [40, 45]]) {
    const params = { windowId: 254, stateId: 1, slot, item: Item.toNotch(stack('birch_planks', 11)) };
    const decoded = wireDecoder.parsePacketBuffer(wireEncoder.createPacketBuffer({ name: 'set_slot', params })).data;
    t.is(decoded.params.windowId, 254);
    s.bot._client.emit(decoded.name, decoded.params);
    t.is(s.authority.getFrame(0).slots[expected]?.count, 11);
  }
  t.false(s.authority.frames.has(254));
});

test('review: 3x3 shaped recipe uses table window mapping and returns confirmed inventory output', async t => {
  const s = recipeServer({ table: true, layout: { 1: 'birch_planks', 2: 'birch_planks', 3: 'birch_planks', 5: 'stick', 8: 'stick' }, output: 'wooden_pickaxe', outputCount: 1, initial: { 9: ['birch_planks', 3], 10: ['stick', 2] } });
  const blank = { id: -1 };
  const recipe: VerifiedRecipe = { requiresTable: true, result: { id: id('wooden_pickaxe'), count: 1 }, inShape: [[{ id: id('birch_planks') }, { id: id('birch_planks') }, { id: id('birch_planks') }], [blank, { id: id('stick') }, blank], [blank, { id: id('stick') }, blank]] };
  const result = await craftVerified(s.bot, recipe, s.table, 20);
  t.is(result.outputCount, 1);
  t.is(s.authority.count(id('wooden_pickaxe')), 1);
  t.is(s.authority.count(id('birch_planks')), 0);
  t.is(s.authority.count(id('stick')), 0);
  t.true(s.writes.every(p => p.windowId === 31));
  t.is(s.getClosed(), 1);
  t.is(s.authority.cursor, null);
});

test('review: shapeless recipe consumes one ingredient and reports exact output count', async t => {
  const s = recipeServer({ layout: { 1: 'birch_log' }, output: 'birch_planks', outputCount: 4, initial: { 9: ['birch_log', 2] } });
  const recipe: VerifiedRecipe = { result: { id: id('birch_planks'), count: 4 }, ingredients: [{ id: id('birch_log'), count: -1 }] };
  await craftVerified(s.bot, recipe, undefined, 20);
  t.is(s.authority.count(id('birch_planks')), 4);
  t.is(s.authority.count(id('birch_log')), 1);
});

test('review: honey bottle remainder is recovered when upstream recipe omits outShape', async t => {
  const s = recipeServer({ layout: { 1: 'honey_bottle' }, output: 'sugar', outputCount: 3, initial: { 9: ['honey_bottle', 1] }, remainders: { 1: 'glass_bottle' } });
  const recipe: VerifiedRecipe = { result: { id: id('sugar'), count: 3 }, ingredients: [{ id: id('honey_bottle'), count: -1 }], outShape: null };
  await craftVerified(s.bot, recipe, undefined, 20);
  t.is(s.authority.count(id('honey_bottle')), 0);
  t.is(s.authority.count(id('glass_bottle')), 1);
  t.is(s.authority.count(id('sugar')), 3);
  t.is(s.authority.cursor, null);
  t.is(s.authority.fence, null);
});

test('review: declared remainder loss is never reported as complete crafting', async t => {
  const s = recipeServer({ layout: { 1: 'honey_bottle' }, output: 'sugar', outputCount: 3, initial: { 9: ['honey_bottle', 1] }, remainders: { 1: 'glass_bottle' }, omitRemainder: true });
  const recipe: VerifiedRecipe = { result: { id: id('sugar'), count: 3 }, ingredients: [{ id: id('honey_bottle'), count: -1 }], outShape: [[{ id: id('glass_bottle'), count: 1 }]] };
  await t.throwsAsync(craftVerified(s.bot, recipe, undefined, 10));
  t.truthy(s.authority.fence);
});

test('review: equipment selection does not assume same-item stacks will swap', async t => {
  const s = recipeServer({ layout: {}, output: 'birch_planks', outputCount: 4, initial: { 9: ['birch_planks', 2], 36: ['birch_planks', 5] } });
  await equipVerified(s.bot, 9, 'hand', 10);
  t.is(s.authority.count(id('birch_planks')), 7);
  t.is(s.authority.cursor, null);
  t.is(s.authority.fence, null);
  t.is(s.bot.quickBarSlot, 0);
});

test('review: equipment swaps distinct occupied slots and preserves both items', async t => {
  const s = recipeServer({ layout: {}, output: 'birch_planks', outputCount: 4, initial: { 9: ['wooden_pickaxe', 1], 36: ['stone', 16] } });
  await equipVerified(s.bot, 9, 'hand', 10);
  t.is(s.authority.getFrame(0).slots[36]?.type, id('wooden_pickaxe'));
  t.is(s.authority.getFrame(0).slots[9]?.type, id('stone'));
  t.is(s.authority.count(id('stone')), 16);
  t.is(s.authority.cursor, null);
});

test('equipment: a server-confirmed door pickup during the exact tool swap is conserved', async t => {
  const s = recipeServer({ wireFragments: true, layout: {}, output: 'birch_planks', outputCount: 4,
    initial: { 32: ['stone_shovel', 1], 44: ['iron_axe', 1], 41: ['birch_door', 1] },
    duringClick: (slots, n) => { if (n === 2) slots[41] = stack('birch_door', 2); } });
  s.bot.quickBarSlot = 8;
  await equipVerified(s.bot, 32, 'hand', 20);
  t.is(s.authority.getFrame(0).slots[44]?.type, id('stone_shovel'));
  t.is(s.authority.getFrame(0).slots[32]?.type, id('iron_axe'));
  t.is(s.authority.getFrame(0).slots[41]?.count, 2);
  t.is(s.authority.cursor, null);
  t.is(s.authority.fence, null);
});

test('equipment: a server-confirmed pickup into an empty unrelated storage slot is safe', async t => {
  const s = recipeServer({ wireFragments: true, layout: {}, output: 'birch_planks', outputCount: 4,
    initial: { 32: ['stone_shovel', 1], 36: ['iron_axe', 1] },
    duringClick: (slots, n) => { if (n === 2) slots[19] = stack('ladder', 1); } });
  await equipVerified(s.bot, 32, 'hand', 20);
  t.is(s.authority.getFrame(0).slots[19]?.type, id('ladder'));
  t.is(s.authority.cursor, null);
  t.is(s.authority.fence, null);
});

for (const [label, change] of [
  ['unrelated loss', (slots: FakeItem[]) => { slots[41] = stack('birch_door', 1); }],
  ['unrelated removal', (slots: FakeItem[]) => { slots[41] = null; }],
  ['unrelated replacement', (slots: FakeItem[]) => { slots[41] = stack('oak_door', 2); }],
  ['unrelated component change', (slots: FakeItem[]) => { slots[41] = stack('birch_door', 3); Object.assign(slots[41]!, { components: [{ type: 'max_stack_size', data: 32 }] }); }],
  ['unknown-type gain', (slots: FakeItem[]) => { slots[19] = new Item(65535, 1); }],
  ['over-cap gain', (slots: FakeItem[]) => { slots[19] = stack('ladder', 65); }],
  ['crafting-grid addition', (slots: FakeItem[]) => { slots[1] = stack('birch_planks', 1); }],
  ['armor-slot addition', (slots: FakeItem[]) => { slots[5] = stack('iron_helmet', 1); }],
  ['offhand-slot addition', (slots: FakeItem[]) => { slots[45] = stack('torch', 1); }],
  ['source-target mismatch', (slots: FakeItem[]) => { slots[36] = stack('stone_pickaxe', 1); }],
  ['target-count mismatch', (slots: FakeItem[]) => { slots[36] = stack('stone_shovel', 2); }],
] as const) {
  test(`equipment: ${label} still fences despite an unrelated valid pickup`, async t => {
    const s = recipeServer({ wireFragments: true, layout: {}, output: 'birch_planks', outputCount: 4,
      initial: { 32: ['stone_shovel', 1], 36: ['iron_axe', 1], 41: ['birch_door', 2] },
      duringClick: (slots, n) => { if (n === 3) { slots[19] = stack('ladder', 1); change(slots); } } });
    await t.throwsAsync(equipVerified(s.bot, 32, 'hand', 20), { message: /conservation/ });
    t.truthy(s.authority.fence);
    t.is(s.authority.cursor, null);
    const writes = s.writes.length;
    await t.throwsAsync(equipVerified(s.bot, 32, 'hand', 20), { message: /safety lock/ });
    t.is(s.writes.length, writes);
  });
}
