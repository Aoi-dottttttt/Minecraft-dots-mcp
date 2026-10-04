import test from 'ava';
import { openWindowVerified, readWindowVerified, transferWindowVerified, furnaceActionVerified, clickWindowVerified, closeWindowVerified, readFurnaceVerified, selectWindowOptionVerified, dropItemVerified, windowLayout } from '../src/verified-window-actions.js';
import { windowFixture } from './helpers/window-fixture.js';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const options = { timeoutMs: 1000 };

test('opens only with a fresh complete authoritative frame and exposes exact player mapping', async t => {
  const s = windowFixture();
  await openWindowVerified(s.bot, s.bot.blockAt(s.bot.entity.position)!, options);
  const snapshot = readWindowVerified(s.bot);
  t.is(snapshot.type, 'minecraft:generic_9x3'); t.is(snapshot.slots[27].playerSlot, 9); t.is(snapshot.slots[0].playerSlot, null); t.is(snapshot.evidence, 'server_packets');
  t.is(snapshot.slots[27].item?.count, 4);
  s.native.slots[27] = null;
  t.is(readWindowVerified(s.bot).slots[27].item?.count, 4);
});

test('partial transfer confirms source, destination and empty cursor without optimistic calls', async t => {
  const s = windowFixture(); s.open();
  const result = await transferWindowVerified(s.bot, { ...options, sourceSlots: [27], destinationSlots: [0], count: 2 });
  t.is(result.transferred, 2); t.is(s.authority.getFrame(7).slots[0]?.count, 2); t.is(s.authority.getFrame(0).slots[9]?.count, 2); t.is(s.authority.cursor, null);
  t.is(s.writes.length, 2); t.true(s.writes.every(write => write.name === 'window_click' && JSON.stringify(write.packet.changedSlots) === '[]'));
});

test('transfers span stacks, preserve exact requested counts and return remainder', async t => {
  const s = windowFixture('minecraft:generic_9x1', 9, [{ name: 'coal', count: 3, slot: 9 }, { name: 'coal', count: 4, slot: 10 }]); s.open();
  const result = await transferWindowVerified(s.bot, { ...options, sourceSlots: [9, 10], destinationSlots: [0], count: 5 });
  t.is(result.transferred, 5); t.is(s.authority.getFrame(7).slots[0]?.count, 5); t.is(s.authority.count(s.bot.registry.itemsByName.coal.id), 2); t.is(s.authority.cursor, null);
});

test('standalone furnace input and fuel deposit confirms packet-driven source removal', async t => {
  const s = windowFixture('minecraft:furnace', 3, [{ name: 'coal', count: 4, slot: 9 }, { name: 'cobblestone', count: 64, slot: 10 }, { name: 'cobblestone', count: 40, slot: 11 }]); s.open();
  await furnaceActionVerified(s.bot, { ...options, slot: 'fuel', op: 'put', itemName: 'coal', count: 2 });
  await furnaceActionVerified(s.bot, { ...options, slot: 'input', op: 'put', itemName: 'cobblestone', count: 16 });
  const status = readFurnaceVerified(s.bot);
  t.is(status.fuel?.count, 2); t.is(status.input?.count, 16); t.is(s.authority.count(s.bot.registry.itemsByName.coal.id), 2); t.is(s.authority.count(s.bot.registry.itemsByName.cobblestone.id), 88); t.is(status.cursor, null);
});

test('output withdrawal accepts an authoritative refill only with a fresh exact cursor', async t => {
  const s = windowFixture('minecraft:furnace', 3); s.open(); s.slots[2] = s.item('stone', 4); s.sync(); s.settings.refillOutput = true;
  const result = await furnaceActionVerified(s.bot, { ...options, slot: 'output', op: 'take' });
  t.is(result.transferred, 4); t.is(s.authority.count(s.bot.registry.itemsByName.stone.id), 4); t.is(s.authority.getFrame(7).slots[2]?.count, 4); t.is(s.authority.fence, null);
});

test('optimistic local-only mutation times out, fences and sends no later packets', async t => {
  const s = windowFixture(); s.open(); s.settings.optimisticOnly = true;
  await t.throwsAsync(transferWindowVerified(s.bot, { sourceSlots: [27], destinationSlots: [0], count: 2, timeoutMs: 500 }), { message: /timed out|deadline/ });
  t.truthy(s.authority.fence); t.is(s.writes.length, 1); t.is(s.authority.getFrame(0).slots[9]?.count, 4);
  await new Promise(resolve => setTimeout(resolve, 25)); t.is(s.writes.length, 1); t.is(s.authority.listenerCount('change'), 0);
});

test('rejected full-frame correction cannot be mistaken for successful transfer', async t => {
  const s = windowFixture(); s.open(); s.settings.reject = true;
  await t.throwsAsync(transferWindowVerified(s.bot, { sourceSlots: [27], destinationSlots: [0], count: 2, timeoutMs: 500 }));
  t.truthy(s.authority.fence); t.is(s.authority.count(s.bot.registry.itemsByName.coal.id), 4); t.is(s.writes.length, 1);
});

test('preflight capacity rejection sends no packet and does not fence', async t => {
  const s = windowFixture(); s.open(); s.slots[0] = s.item('stone', 64); s.sync();
  await t.throwsAsync(transferWindowVerified(s.bot, { ...options, sourceSlots: [27], destinationSlots: [0] }), { message: /capacity/ });
  t.is(s.writes.length, 0); t.is(s.authority.fence, null);
});

test('new window during a pending click stops and fences even with matching slot data', async t => {
  const s = windowFixture(); s.open(); s.settings.onClick = () => { s.bot._client.emit('open_window', { windowId: 7 }); };
  await t.throwsAsync(transferWindowVerified(s.bot, { ...options, sourceSlots: [27], destinationSlots: [0] }), { message: /Window changed/ });
  t.truthy(s.authority.fence); t.is(s.writes.length, 1);
});

test('cancellation after pickup leaves no background transfer and retains fenced cursor', async t => {
  const s = windowFixture(); s.open(); const controller = new AbortController(); s.settings.onClick = () => controller.abort();
  await t.throwsAsync(transferWindowVerified(s.bot, { ...options, signal: controller.signal, sourceSlots: [27], destinationSlots: [0] }), { message: /cancelled/ });
  t.truthy(s.authority.fence); t.is(s.writes.length, 1); t.is(s.authority.cursor?.count, 4);
});

test('disconnect after pickup fences immediately', async t => {
  const s = windowFixture(); s.open(); s.settings.onClick = () => s.bot.emit('end', 'fixture disconnect');
  await t.throwsAsync(transferWindowVerified(s.bot, { ...options, sourceSlots: [27], destinationSlots: [0] }), { message: /session ended/ });
  t.truthy(s.authority.fence); t.is(s.writes.length, 1);
});

test('close returns honest no-server-ack status and rejects an occupied cursor', async t => {
  const s = windowFixture(); s.open();
  await clickWindowVerified(s.bot, { ...options, slot: 27 });
  await t.throwsAsync(closeWindowVerified(s.bot), { message: /Cursor is holding/ });
  await clickWindowVerified(s.bot, { ...options, slot: 27 });
  const result = await closeWindowVerified(s.bot);
  t.true(result.closePacketSent); t.false(result.serverAcknowledged); t.is(s.bot.currentWindow, null);
});

test('player inventory supports exact-slot transfer and fresh cursor evidence', async t => {
  const s = inventoryFixture([{ name: 'iron_pickaxe', count: 1, slot: 9 }]);
  const result = await transferWindowVerified(s.bot, { ...options, sourceSlots: [9], destinationSlots: [36] });
  t.is(result.transferred, 1); t.is(result.window.slots[36].item?.name, 'iron_pickaxe'); t.is(s.authority.cursor, null);
});

test('server full-frame length corrects smithing mapping despite client-library mismatch', t => {
  const s = windowFixture('minecraft:smithing', 4); s.native.inventoryStart = 3; s.open();
  const frame = s.authority.getFrame(7);
  t.is(frame.inventoryStart, 4); t.is(frame.slots.length, 40); t.is(frame.slots[4]?.name, 'coal'); t.is(s.authority.getFrame(0).slots[9]?.name, 'coal');
  const snapshot = readWindowVerified(s.bot); t.deepEqual(snapshot.layout.roles, { template: [0], base: [1], addition: [2], output: [3] });
});

test('early partial packet never contaminates player inventory and full packet resizes its frame', t => {
  const s = windowFixture('minecraft:furnace', 3); const Item = require('prismarine-item')(s.bot.registry);
  s.bot._client.emit('set_slot', { windowId: 7, slot: 10, stateId: 1, item: Item.toNotch(s.item('diamond', 20)) });
  t.is(s.authority.getFrame(0).slots[9]?.name, 'coal');
  s.bot.currentWindow = s.native; s.sync();
  t.is(s.authority.getFrame(7).slots.length, 39); t.is(s.authority.getFrame(7).inventoryStart, 3); t.is(s.authority.count(s.bot.registry.itemsByName.diamond.id), 0);
});

test('stale window contents sent before open cannot prove successful opening', async t => {
  const s = windowFixture(); s.sync(); s.bot.activateBlock = async () => { s.bot.currentWindow = s.native; s.bot._client.emit('open_window', { windowId: 7 }); };
  await t.throwsAsync(openWindowVerified(s.bot, s.bot.blockAt(s.bot.entity.position)!, { timeoutMs: 500 }));
  t.truthy(s.authority.fence); t.is(s.writes.length, 0);
});

test('menu selection requires matching fresh selected property and result slot', async t => {
  const s = windowFixture('minecraft:stonecutter', 2); s.open(); s.slots[0] = s.item('stone', 1); s.sync();
  s.bot._client.write = ((name: string) => {
    if (name === 'enchant_item') { s.slots[1] = s.item('stone_slab', 2); s.sync(); s.bot._client.emit('craft_progress_bar', { windowId: 7, property: 0, value: 1 }); }
  }) as typeof s.bot._client.write;
  const result = await selectWindowOptionVerified(s.bot, 1, options);
  t.is(result.properties[0], 1); t.is(result.slots[1].item?.name, 'stone_slab');
});

test('unsupported menu types and wrong slot layouts fail before mutation', async t => {
  const s = windowFixture(); s.open();
  await t.throwsAsync(selectWindowOptionVerified(s.bot, 0, options), { message: /only stonecutter and loom/ });
  t.throws(() => windowLayout('minecraft:smithing', 3), { message: /expected 4/ }); t.is(s.writes.length, 0);
});

test('unknown windows remain inspectable with explicit unsupported-layout metadata', async t => {
  const s = windowFixture('minecraft:unknown_vanilla', 4); s.open();
  const snapshot = readWindowVerified(s.bot);
  t.false(snapshot.layout.supported); t.is(snapshot.id, 7); t.is(snapshot.slots[4].item?.name, 'coal'); t.regex(snapshot.layout.limitation!, /Unsupported exact window/);
  await t.throwsAsync(clickWindowVerified(s.bot, { ...options, slot: 4 }), { message: /Unsupported exact window/ }); t.is(s.writes.length, 0);
});

test('slot correction without fresh cursor evidence cannot prove a click', async t => {
  const s = windowFixture(); s.open(); const Item = require('prismarine-item')(s.bot.registry);
  s.bot._client.write = (() => { s.bot._client.emit('set_slot', { windowId: 7, slot: 27, stateId: 2, item: Item.toNotch(null) }); }) as typeof s.bot._client.write;
  await t.throwsAsync(clickWindowVerified(s.bot, { slot: 27, timeoutMs: 500 })); t.truthy(s.authority.fence); t.is(s.authority.cursor, null);
});

test('unsigned protocol 767 cursor corrections prove a click without local slot events', async t => {
  const s = windowFixture(); s.open(); const Item = require('prismarine-item')(s.bot.registry);
  s.bot._client.write = (() => {
    s.bot._client.emit('set_slot', { windowId: 7, slot: 27, stateId: 2, item: Item.toNotch(null) });
    s.bot._client.emit('set_slot', { windowId: 255, slot: -1, stateId: -1, item: Item.toNotch(s.item('coal', 4)) });
  }) as typeof s.bot._client.write;
  const snapshot = await clickWindowVerified(s.bot, { ...options, slot: 27 }); t.is(snapshot.cursor?.count, 4); t.is(snapshot.slots[27].item, null); t.is(s.authority.fence, null);
});

test('pre-aborted transfer sends no packet and leaves the inventory unlocked', async t => {
  const s = windowFixture(); s.open(); const controller = new AbortController(); controller.abort();
  await t.throwsAsync(transferWindowVerified(s.bot, { ...options, signal: controller.signal, sourceSlots: [27], destinationSlots: [0] }), { message: /cancelled/ }); t.is(s.writes.length, 0); t.is(s.authority.fence, null);
});

test('concurrent direct window actions reject while a click is pending', async t => {
  const s = windowFixture(); s.open(); s.settings.optimisticOnly = true;
  const pending = clickWindowVerified(s.bot, { slot: 27, timeoutMs: 500 });
  await t.throwsAsync(clickWindowVerified(s.bot, { ...options, slot: 28 }), { message: /still running/ });
  await t.throwsAsync(pending); t.is(s.writes.length, 1);
});

test('server-corrected source without successful destination cannot report transfer success', async t => {
  const s = windowFixture(); s.open(); const write = s.bot._client.write.bind(s.bot._client);
  s.bot._client.write = ((name: string, raw: unknown) => {
    if ((raw as { slot: number }).slot === 0) s.settings.reject = true;
    write(name, raw);
  }) as typeof s.bot._client.write;
  await t.throwsAsync(transferWindowVerified(s.bot, { sourceSlots: [27], destinationSlots: [0], count: 4, timeoutMs: 500 }));
  t.is(s.authority.getFrame(7).slots[0], null); t.is(s.authority.cursor?.count, 4); t.truthy(s.authority.fence); t.is(s.writes.length, 2);
});

test('explicit whole-stack drop confirms removed cursor and source without claiming landing', async t => {
  const s = inventoryFixture([{ name: 'coal', count: 4, slot: 9 }]); const Item = require('prismarine-item')(s.bot.registry);
  let cursor: unknown = null; let state = 1;
  s.bot._client.write = ((_name: string, raw: unknown) => {
    const slot = (raw as { slot: number }).slot;
    if (slot === 9) { cursor = s.slots[9]; s.slots[9] = null; }
    else if (slot === -999) cursor = null;
    s.bot._client.emit('window_items', { windowId: 0, stateId: ++state, items: s.slots.map(value => Item.toNotch(value)), carriedItem: Item.toNotch(cursor) });
  }) as typeof s.bot._client.write;
  const result = await dropItemVerified(s.bot, 9, undefined, options);
  t.is(result.dropped, 4); t.false(result.landingConfirmed); t.is(s.authority.count(s.bot.registry.itemsByName.coal.id), 0); t.is(s.authority.cursor, null);
});

test('unsigned special player correction uses server smithing width instead of stale library width', t => {
  const s = windowFixture('minecraft:smithing', 4); s.native.inventoryStart = 3; s.open(); const Item = require('prismarine-item')(s.bot.registry);
  s.bot._client.emit('set_slot', { windowId: 254, slot: 9, stateId: 0, item: Item.toNotch(s.item('coal', 2)) });
  t.is(s.authority.getFrame(7).slots[4]?.count, 2); t.is(s.authority.getFrame(7).slots[3], null); t.is(s.authority.getFrame(0).slots[9]?.count, 2);
});

test('validated open aligns local smithing menu metadata so close copies correct player slots', async t => {
  const s = windowFixture('minecraft:smithing', 4); s.native.inventoryStart = 3; s.native.inventoryEnd = 39; s.native.craftingResultSlot = 2;
  await openWindowVerified(s.bot, s.bot.blockAt(s.bot.entity.position)!, options);
  t.is(s.native.inventoryStart, 4); t.is(s.native.inventoryEnd, 40); t.is(s.native.hotbarStart, 31); t.is(s.native.craftingResultSlot, 3);
});

test('small menus without a player region never overwrite player storage', t => {
  const s = windowFixture(); const Item = require('prismarine-item')(s.bot.registry);
  s.bot._client.emit('window_items', { windowId: 8, stateId: 1, items: [Item.toNotch(s.item('written_book', 1))], carriedItem: Item.toNotch(null) });
  const frame = s.authority.getFrame(8);
  t.is(frame.inventoryStart, 1); t.is(frame.inventoryEnd, 1); t.is(s.authority.getFrame(0).slots[9]?.name, 'coal');
});
