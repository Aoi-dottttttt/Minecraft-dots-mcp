/* eslint-disable @typescript-eslint/no-explicit-any */
import test from 'ava';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { z } from 'zod';
import mineflayer from 'mineflayer';
import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { waitForNativePlugins } from '../src/bot-startup.js';
import { installInventoryAuthority } from '../src/inventory-authority.js';
import { registerCompleteControls } from '../src/complete-controls.js';
import { craftVerified } from '../src/verified-crafting.js';
import { windowLayout } from '../src/verified-window-actions.js';
import { windowFixture } from './helpers/window-fixture.js';
import { registerInventoryTools } from '../src/tools/inventory-tools.js';
import { registerCraftingTools } from '../src/tools/crafting-tools.js';
import { registerFurnaceTools } from '../src/tools/furnace-tools.js';
import { registerBlockTools } from '../src/tools/block-tools.js';
import type { Bot } from 'mineflayer';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { equipVerified } from '../src/verified-inventory.js';
import { selectInteractionItem } from '../src/survival-interactions.js';
import { registerInteractionTools } from '../src/tools/interaction-tools.js';
import { ToolFactory } from '../src/tool-factory.js';

/** Acknowledges only synthetic packet writes; no network client or game exists. */
function cancelledEquipFixture() {
  const s = inventoryFixture([{ name: 'iron_pickaxe', count: 1, slot: 9 }]);
  const controller = new AbortController();
  const write = s.bot._client.write.bind(s.bot._client);
  s.bot._client.write = ((name: string, packet: unknown) => {
    write(name, packet);
    if (s.writes.length === 1) controller.abort();
  }) as Bot['_client']['write'];
  return { ...s, controller };
}

test('systematic: direct verified equip stops after the first acknowledged click on cancellation', async t => {
  const s = cancelledEquipFixture();
  await t.throwsAsync(equipVerified(s.bot, 9, 'hand', 100, { exactSource: true, signal: s.controller.signal }), { message: /abort|cancel/i });
  t.is(s.writes.length, 1);
  t.truthy(s.authority.fence);
  t.is(s.authority.listenerCount('change'), 0);
});

for (const offHand of [false, true]) {
  test(`systematic: ${offHand ? 'offhand' : 'mainhand'} interaction selection preserves cancellation inside equipment transfer`, async t => {
    const s = cancelledEquipFixture();
    await t.throwsAsync(selectInteractionItem(s.bot, { inventorySlot: 9 }, offHand, { timeoutMs: 100, signal: s.controller.signal }), { message: /abort|cancel/i });
    t.is(s.writes.length, 1, 'An abort must stop before issuing a second inventory click');
    t.truthy(s.authority.fence);
    t.is(s.authority.listenerCount('change'), 0);
  });
}

test('systematic: exact-slot tool propagates cancellation into the underlying equipment transfer', async t => {
  const s = cancelledEquipFixture();
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const factory = {
    registerTool(name: string, _description: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) { handlers.set(name, handler); },
    createResponse: (text: string) => ({ content: [{ type: 'text', text }] })
  } as unknown as ToolFactory;
  registerInteractionTools(factory, () => s.bot, () => ({ signal: s.controller.signal }));
  await t.throwsAsync(handlers.get('equip-inventory-slot')!({ inventorySlot: 9, destination: 'hand', timeoutMs: 100 }), { message: /abort|cancel/i });
  t.is(s.writes.length, 1, 'The exact-slot public tool must not finish additional clicks after stop');
  t.truthy(s.authority.fence);
  t.is(s.authority.listenerCount('change'), 0);
});


/** Real pinned Mineflayer/plugin registration with an EventEmitter protocol client. */
async function offlineControls(itemName: string) {
  const writes: Array<{ name: string; packet: any }> = [];
  const client = Object.assign(new EventEmitter(), {
    version: '1.21.1', write(name: string, packet: unknown) { writes.push({ name, packet }); },
    end() {}, registerChannel() {}, unregisterChannel() {}, writeChannel() {}
  });
  const bot = mineflayer.createBot({ client: client as any, version: '1.21.1', logErrors: false, hideErrors: true, physicsEnabled: false });
  const ready = waitForNativePlugins(bot);
  const authority = installInventoryAuthority(bot);
  bot.loadPlugin(pathfinder.pathfinder);
  await ready;
  const raw = bot as any;
  const Item = createRequire(import.meta.url)('prismarine-item')(bot.registry);
  const slots: any[] = Array(46).fill(null);
  slots[9] = new Item(bot.registry.itemsByName[itemName].id, 1);
  raw.entity = { id: 3, position: new Vec3(0, 64, 0), yaw: 0, pitch: 0, effects: {} };
  raw.food = 20; raw.health = 20; raw.quickBarSlot = 0;
  raw.blockAt = () => null;
  let cursor: any = null, stateId = 10;
  const sync = () => client.emit('window_items', { windowId: 0, stateId: stateId++, items: slots.map(item => Item.toNotch(item)), carriedItem: Item.toNotch(cursor) });
  sync();
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const server: any = { tool(name: string, _description: string, _schema: unknown, handler: (args: any) => Promise<any>) { handlers.set(name, handler); } };
  const reads = new Set<string>();
  const factory = new ToolFactory(server, { checkConnectionAndReconnect: async () => ({ connected: !authority.ended }), assertActionAllowed(name: string) { if (!reads.has(name)) authority.assertMutationReady(); } } as any);
  const complete = await registerCompleteControls({ server, factory, bot, legacy: new Map(), markRead: name => reads.add(name), stateRoot: '/tmp/minecraft-systematic-offline-fixture' });
  let afterClick = () => {};
  const clicks = () => writes.filter(write => write.name === 'window_click');
  client.write = (name, packet: any) => {
    writes.push({ name, packet });
    if (name !== 'window_click') return;
    const old = slots[packet.slot];
    if (packet.mouseButton === 1 && cursor) {
      slots[packet.slot] = new Item(cursor.type, 1);
      cursor = cursor.count === 1 ? null : new Item(cursor.type, cursor.count - 1);
    } else { slots[packet.slot] = cursor; cursor = old; }
    if (itemName === 'oak_log') {
      if (packet.slot === 1 && slots[1]?.name === 'oak_log') slots[0] = new Item(bot.registry.itemsByName.oak_planks.id, 4);
      if (packet.slot === 0 && cursor?.name === 'oak_planks') slots[1] = null;
    }
    sync();
    afterClick();
  };
  return { bot, raw, client, slots, authority, writes, complete, factory, handlers, clicks, onClick: (fn: () => void) => { afterClick = fn; } };
}

for (const cancelledAt of [1, 2, 3, 4]) {
  test.serial(`systematic: cancelling a craft at acknowledged click ${cancelledAt} prevents every later click`, async t => {
    const s = await offlineControls('oak_log');
    t.teardown(() => { s.client.emit('end', 'offline test complete'); });
    s.raw.findBlock = () => null;
    s.raw.recipesFor = () => [{ result: { id: s.bot.registry.itemsByName.oak_planks.id, count: 4 }, ingredients: [{ id: s.bot.registry.itemsByName.oak_log.id }] }];
    s.onClick(() => { if (s.clicks().length === cancelledAt) void s.complete.stop(); });
    const outcome = await s.handlers.get('craft_item')!({ item: 'oak_planks', count: 1 });
    t.true(outcome.isError);
    t.is(s.clicks().length, cancelledAt, 'Cancellation must reach the per-click crafting boundary, not merely the next whole recipe');
    t.truthy(s.authority.fence);
    if (cancelledAt < 4) t.is(s.authority.count(s.bot.registry.itemsByName.oak_planks.id), 0);
    const after = await s.handlers.get('equip_item')!({ item: 'oak_planks', destination: 'hand' });
    t.true(after.isError);
    t.is(s.clicks().length, cancelledAt, 'An unrelated tool must not clear the cancelled craft fence');
    t.is(s.authority.listenerCount('change'), 0);
  });
}

test.serial('systematic: cancelling write_book during selection prevents the later book edit', async t => {
  const s = await offlineControls('writable_book');
  t.teardown(() => { s.client.emit('end', 'offline test complete'); });
  let edits = 0;
  s.raw.writeBook = async () => { edits++; };
  s.onClick(() => { if (s.clicks().length === 1) void s.complete.stop(); });
  const outcome = await s.handlers.get('write_book')!({ slot: 9, pages: ['Synthetic offline page'] });
  t.true(outcome.isError);
  t.is(edits, 0, 'A stopped action must not issue a book edit after its equipment preparation');
  t.is(s.clicks().length, 1);
  t.truthy(s.authority.fence);
});


test('systematic: pre-cancelled crafting is mutation-free and does not create an uncertainty fence', async t => {
  const s = inventoryFixture([{ name: 'oak_log', count: 1, slot: 9 }]);
  const controller = new AbortController(); controller.abort();
  const recipe = { result: { id: s.bot.registry.itemsByName.oak_planks.id, count: 4 }, ingredients: [{ id: s.bot.registry.itemsByName.oak_log.id }] };
  await t.throwsAsync(craftVerified(s.bot, recipe, undefined, 100, { signal: controller.signal }), { message: /abort|cancel/i });
  t.is(s.writes.length, 0); t.is(s.authority.fence, null);
});

for (const operation of ['select-item', 'craft'] as const) {
  test(`systematic: ${operation} cancellation while awaiting ACK settles and ignores a late acknowledgement`, async t => {
    const s = inventoryFixture([{ name: operation === 'craft' ? 'oak_log' : 'iron_pickaxe', count: 1, slot: 9 }]);
    const controller = new AbortController();
    const nativeWrite = s.bot._client.write.bind(s.bot._client);
    const requests: Array<{ name: string; packet: unknown }> = [];
    s.bot._client.write = ((name: string, packet: unknown) => { requests.push({ name, packet }); queueMicrotask(() => controller.abort()); }) as Bot['_client']['write'];
    const promise = operation === 'select-item'
      ? selectInteractionItem(s.bot, { inventorySlot: 9 }, false, { timeoutMs: 500, signal: controller.signal })
      : craftVerified(s.bot, { result: { id: s.bot.registry.itemsByName.oak_planks.id, count: 4 }, ingredients: [{ id: s.bot.registry.itemsByName.oak_log.id }] }, undefined, 500, { signal: controller.signal });
    await t.throwsAsync(promise, { message: /abort|cancel/i });
    t.is(requests.length, 1); t.truthy(s.authority.fence);
    nativeWrite(requests[0].name, requests[0].packet as never);
    await Promise.resolve(); await Promise.resolve();
    t.is(requests.length, 1, 'Late authoritative ACK must never resume or replay a cancelled operation');
    t.truthy(s.authority.fence); t.truthy(s.authority.cursor);
    t.is(s.authority.listenerCount('change'), 0);
  });
}


const menuLayouts: Array<[string, number]> = [
  ...Array.from({ length: 6 }, (_, index): [string, number] => [`minecraft:generic_9x${index + 1}`, 9 * (index + 1)]),
  ['minecraft:generic_3x3', 9], ['minecraft:shulker_box', 27], ['minecraft:hopper', 5],
  ['minecraft:furnace', 3], ['minecraft:blast_furnace', 3], ['minecraft:smoker', 3],
  ['minecraft:inventory', 9], ['minecraft:crafting', 10], ['minecraft:anvil', 3],
  ['minecraft:grindstone', 3], ['minecraft:smithing', 4], ['minecraft:cartography', 3],
  ['minecraft:stonecutter', 2], ['minecraft:loom', 4], ['minecraft:enchantment', 2],
  ['minecraft:brewing_stand', 5], ['minecraft:merchant', 3], ['minecraft:beacon', 1],
  ['minecraft:crafter_3x3', 9]
];
for (const [name, width] of menuLayouts) {
  test(`systematic: ${name} exact-layout contract rejects both neighboring ambiguous widths`, t => {
    const layout = windowLayout(name, width);
    t.true(layout.supported);
    t.is(layout.containerSlots.length, width);
    t.true(layout.outputSlots.every(slot => !layout.inputSlots.includes(slot)));
    for (const invalidWidth of [width - 1, width + 1]) {
      t.throws(() => windowLayout(name, invalidWidth), { message: /ambiguous slot mapping/ });
    }
  });
}


for (const name of ['equip-item', 'craft-item']) {
  test.serial(`systematic: legacy ${name} shares the integrated cancellation context`, async t => {
    const s = await offlineControls(name === 'craft-item' ? 'oak_log' : 'iron_pickaxe');
    t.teardown(() => { s.client.emit('end', 'offline test complete'); });
    // Same boundary as minecraft-server: only the outer registered legacy
    // mutation enters runAction; its compatibility executor does not nest it.
    const legacyFactory = {
      createResponse: s.factory.createResponse.bind(s.factory),
      createErrorResponse: s.factory.createErrorResponse.bind(s.factory),
      registerTool(tool: string, description: string, schema: any, executor: any) {
        s.factory.registerTool(tool, description, schema, args => s.complete.runAction(() => executor(args)));
      }
    } as unknown as ToolFactory;
    registerInventoryTools(legacyFactory, () => s.bot, s.complete.getOptions);
    registerCraftingTools(legacyFactory, () => s.bot, s.complete.getOptions);
    s.raw.findBlock = () => null;
    s.raw.recipesFor = () => [{ result: { id: s.bot.registry.itemsByName.oak_planks.id, count: 4 }, ingredients: [{ id: s.bot.registry.itemsByName.oak_log.id }] }];
    s.onClick(() => { if (s.clicks().length === 1) void s.complete.stop(); });
    const outcome = await s.handlers.get(name)!(name === 'craft-item' ? { outputItem: 'oak_planks', amount: 1 } : { itemName: 'iron_pickaxe' });
    t.is(s.clicks().length, 1); t.true(outcome.isError); t.truthy(s.authority.fence);
    t.is(s.authority.listenerCount('change'), 0);
  });
}

function capturedFactory() {
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const server: any = { tool(name: string, _description: string, _schema: unknown, handler: (args: any) => Promise<any>) { handlers.set(name, handler); } };
  const factory = new ToolFactory(server, { checkConnectionAndReconnect: async () => ({ connected: true }) } as any);
  return { factory, handlers };
}

test('systematic: legacy smelt-item cancellation after fuel pickup does not deposit fuel or input', async t => {
  const s = windowFixture('minecraft:furnace', 3, [{ name: 'coal', count: 1, slot: 9 }, { name: 'iron_ore', count: 1, slot: 10 }]);
  const controller = new AbortController(); const tools = capturedFactory();
  registerFurnaceTools(tools.factory, () => s.bot, () => ({ signal: controller.signal }));
  s.settings.onClick = () => { if (s.writes.length === 1) controller.abort(); };
  const outcome = await tools.handlers.get('smelt-item')!({ x: 0, y: 0, z: 0, inputItem: 'iron_ore', fuelItem: 'coal', takeOutput: false });
  t.is(s.writes.length, 1); t.true(outcome.isError); t.truthy(s.authority.fence);
  t.truthy(s.bot.currentWindow); t.truthy(s.authority.cursor);
  t.is(s.authority.listenerCount('change'), 0);
});

for (const name of ['place-block', 'dig-block']) {
  test(`systematic: legacy ${name} cancellation at preparation boundary prevents the world mutation`, async t => {
    const s = inventoryFixture([{ name: 'stone', count: 1, slot: 36 }]);
    const controller = new AbortController(); const tools = capturedFactory();
    const target = new Vec3(1, 64, 0), reference = target.offset(0, -1, 0);
    let targetName = name === 'dig-block' ? 'stone' : 'air', sideEffects = 0, navigated = false;
    const block = (name: string, position: Vec3) => ({ name, position, type: s.bot.registry.blocksByName[name].id, stateId: s.bot.registry.blocksByName[name].defaultState });
    Object.assign(s.bot, {
      entity: { id: 3, position: new Vec3(0, 64, 0) }, heldItem: s.authority.getFrame(0).slots[36],
      blockAt: (position: Vec3) => block(position.equals(target) ? targetName : position.equals(reference) ? 'stone' : 'air', position),
      canSeeBlock: () => true, canDigBlock: () => navigated,
      lookAt: async () => { controller.abort(); },
      clearControlStates() {},
      pathfinder: { goto: async () => { navigated = true; controller.abort(); }, setGoal() {} },
      placeBlock: async () => { sideEffects++; targetName = 'stone'; s.bot._client.emit('block_change', { location: target, type: s.bot.registry.blocksByName.stone.defaultState }); },
      dig: async () => { sideEffects++; targetName = 'air'; s.bot._client.emit('block_change', { location: target, type: s.bot.registry.blocksByName.air.defaultState }); }
    });
    registerBlockTools(tools.factory, () => s.bot, () => ({ signal: controller.signal }));
    const outcome = await tools.handlers.get(name)!({ x: target.x, y: target.y, z: target.z });
    t.is(sideEffects, 0, 'Stop after navigation/look must be rechecked before placeBlock or dig');
    t.true(outcome.isError); t.is(s.authority.fence, null); t.is(s.writes.length, 0);
  });
}


test.serial('systematic: actual runtime attack-mob callback cannot attack after cancelled look preparation', async t => {
  const s = await offlineControls('iron_sword');
  t.teardown(() => { s.client.emit('end', 'offline test complete'); });
  const source = readFileSync(new URL('../runtime/minecraft-server.mjs', import.meta.url), 'utf8');
  const registration = source.split('\n').find(line => line.startsWith("factory.registerTool('attack-mob',"));
  t.truthy(registration, 'Exercise the actual production registration, never a rewritten callback');
  let attacks = 0;
  s.raw.entities = { 8: { id: 8, name: 'cow', type: 'mob', height: 1, position: new Vec3(1, 64, 0) } };
  s.raw.lookAt = async () => { await s.complete.stop(); };
  s.raw.attack = () => { attacks++; };
  vm.runInNewContext(registration!, { factory: s.factory, z, bot: s.bot, complete: s.complete, response: (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] }) });
  const outcome = await s.handlers.get('attack-mob')!({ entityId: 8 });
  t.is(attacks, 0); t.true(outcome.isError); t.is(s.authority.fence, null);
});
