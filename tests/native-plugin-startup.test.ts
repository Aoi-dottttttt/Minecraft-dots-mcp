/* eslint-disable @typescript-eslint/no-explicit-any */
import test from 'ava';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { setImmediate as nextTurn } from 'node:timers/promises';
import mineflayer from 'mineflayer';
import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { waitForNativePlugins } from '../src/bot-startup.js';
import { installInventoryAuthority } from '../src/inventory-authority.js';
import { registerCompleteControls } from '../src/complete-controls.js';
import { registerInventoryTools } from '../src/tools/inventory-tools.js';
import { ToolFactory } from '../src/tool-factory.js';

const require = createRequire(import.meta.url);
const guardedNames = ['openBlock', 'openEntity', 'equip', 'craft', 'transfer', 'unequip', 'clickWindow', 'moveSlotItem', 'putAway', 'consume'];

/** Real Mineflayer/plugin lifecycle, supplied protocol client: never opens a socket. */
function createOfflineBot() {
  const writes: Array<{ name: string; packet: any }> = [];
  const client = Object.assign(new EventEmitter(), {
    version: '1.21.1',
    write(name: string, packet: unknown) { writes.push({ name, packet }); },
    end() {}, registerChannel() {}, unregisterChannel() {}, writeChannel() {}
  });
  const bot = mineflayer.createBot({ client: client as any, version: '1.21.1', logErrors: false, hideErrors: true, physicsEnabled: false });
  const ready = waitForNativePlugins(bot);
  const authority = installInventoryAuthority(bot);
  bot.loadPlugin(pathfinder.pathfinder);
  return { bot, client, writes, ready, authority };
}

async function controls() {
  const s = createOfflineBot();
  // A packet can arrive while integration imports are still pending. Tracking
  // starts at createBot and must not be reset after the injection barrier.
  await s.ready;
  const raw = s.bot as any;
  const Item = require('prismarine-item')(s.bot.registry);
  const slots: any[] = Array(46).fill(null);
  slots[13] = new Item(s.bot.registry.itemsByName.iron_pickaxe.id, 1);
  for (let slot = 36; slot < 45; slot++) slots[slot] = new Item(s.bot.registry.itemsByName.dirt.id, 1);
  raw.entity = { id: 3, position: new Vec3(0, 64, 0), yaw: 0, pitch: 0, effects: {} };
  raw.food = 12;
  raw.health = 20;
  raw.quickBarSlot = 3;
  let cursor: any = null, stateId = 378;
  const sync = () => s.client.emit('window_items', { windowId: 0, stateId, items: slots.map(item => Item.toNotch(item)), carriedItem: Item.toNotch(cursor) });
  sync();
  const beforeIntegration = s.authority.sequence;
  const block = { name: 'stone', type: s.bot.registry.blocksByName.stone.id, boundingBox: 'block', position: new Vec3(1, 64, 0), digTime: (type: number) => type === s.bot.registry.itemsByName.iron_pickaxe.id ? 1 : 100, canHarvest: () => true };
  raw.blockAt = () => block;
  raw.canDigBlock = () => true;
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const server: any = { tool(name: string, _description: string, _schema: unknown, handler: (args: any) => Promise<any>) { handlers.set(name, handler); } };
  const reads = new Set(['list-inventory', 'find-item']);
  const factory = new ToolFactory(server, { checkConnectionAndReconnect: async () => ({ connected: !s.authority.ended }), assertActionAllowed(name: string) { if (!reads.has(name)) s.authority.assertMutationReady(); } } as any);
  registerInventoryTools(factory, () => s.bot);
  let digs = 0, placements = 0;
  const legacy = new Map([
    ['dig-block', async () => { digs++; return factory.createResponse('Dug'); }],
    ['place-block', async () => { placements++; return factory.createResponse('Placed'); }]
  ]);
  const complete = await registerCompleteControls({ server, factory, bot: s.bot, legacy, markRead: name => reads.add(name), stateRoot: '/tmp/minecraft-native-plugin-startup-fixture' });
  const clicks = () => s.writes.filter(write => write.name === 'window_click');
  const acknowledge = (index: number) => {
    const { packet } = clicks()[index];
    [slots[packet.slot], cursor] = [cursor, slots[packet.slot]];
    stateId++;
    sync();
  };
  const update = (slot: number, name: string, count: number) => {
    slots[slot] = count ? new Item(s.bot.registry.itemsByName[name].id, count) : null;
    s.client.emit('set_slot', { windowId: 0, stateId: ++stateId, slot, item: Item.toNotch(slots[slot]) });
  };
  const finishEating = () => s.client.emit('entity_status', { entityId: 3, entityStatus: 9 });
  return { ...s, raw, slots, beforeIntegration, block, handlers, complete, factory, clicks, acknowledge, update, finishEating, counts: () => ({ digs, placements }) };
}

for (const cache of ['cold', 'warm']) {
  test.serial(`real createBot ${cache} startup keeps guards and waits between equipForBlock clicks`, async t => {
    const s = await controls();
    t.teardown(() => { s.client.emit('end', 'offline test complete'); });
    t.is(s.authority.sequence, s.beforeIntegration);
    t.is(s.bot.listenerCount('inject_allowed'), 0);
    t.is(typeof s.raw.tool.bot.pathfinder.stop, 'function');
    const installed = guardedNames.map(name => s.raw[name]);
    await nextTurn();
    t.deepEqual(guardedNames.map(name => s.raw[name]), installed);
    let settled = false;
    const action = s.handlers.get('equip_tool_for_block')!({ x: 1, y: 64, z: 0 });
    void action.then(() => { settled = true; });
    await nextTurn();
    t.false(settled);
    t.deepEqual(s.clicks().map(({ packet }) => [packet.slot, packet.stateId, packet.changedSlots]), [[13, 378, []]]);
    t.is(s.bot.inventory.slots[13]?.name, 'iron_pickaxe');
    t.is(s.authority.getFrame(0).slots[13]?.name, 'iron_pickaxe');
    for (let index = 0; index < 3; index++) {
      t.is(s.clicks().length, index + 1);
      s.acknowledge(index);
      await nextTurn();
    }
    const result = await action;
    t.not(result.isError, true);
    t.deepEqual(s.clicks().map(({ packet }) => [packet.slot, packet.stateId, packet.changedSlots]), [[13, 378, []], [39, 379, []], [13, 380, []]]);
    t.is(s.authority.getFrame(0).slots[13]?.name, 'dirt');
    t.is(s.bot.inventory.slots[13]?.name, 'dirt');
    t.is(s.authority.getFrame(0).slots[39]?.name, 'iron_pickaxe');
    t.is(s.authority.cursor, null);
    t.is(s.authority.fence, null);
    t.is(s.authority.listenerCount('change'), 0);
  });
}

for (const event of ['end', 'error', 'kicked'] as const) {
  test.serial(`real createBot rejects ${event} before native initialization and removes startup listeners`, async t => {
    const s = createOfflineBot();
    const injected = new Promise<void>(resolve => s.bot.once('inject_allowed', resolve));
    const rejection = t.throwsAsync(s.ready, { message: /before native plugin initialization|initialization failed/ });
    if (event === 'error') s.bot.emit('error', new Error('offline transport loss'));
    else (s.bot as unknown as EventEmitter).emit(event, 'offline transport loss');
    await rejection;
    // Let the actual queued native injection finish; it must not resurrect readiness.
    await injected;
    t.is(s.bot.listenerCount('inject_allowed'), 0);
    t.false(s.bot.listeners('end').some(listener => listener.name === 'ended'));
    t.false(s.bot.listeners('error').some(listener => listener.name === 'failed'));
    t.is((s.bot as any).tool, undefined);
    t.is(s.writes.length, 0);
    s.client.emit('end', 'offline cleanup');
  });
}

test.serial('native initialization cancellation and missing completion settle without lingering listeners', async t => {
  for (const reason of ['abort', 'timeout']) {
    const bot = new EventEmitter() as unknown as mineflayer.Bot;
    const controller = new AbortController();
    const ready = waitForNativePlugins(bot, { signal: controller.signal, timeoutMs: reason === 'timeout' ? 1 : 1000 });
    if (reason === 'abort') controller.abort();
    await t.throwsAsync(ready, { message: /cancelled|timed out/ });
    t.deepEqual(bot.eventNames(), []);
  }
});

for (const lane of ['legacy', 'integrated', 'plugin']) {
  test.serial(`guard replacement fences the ${lane} lane before any mutation`, async t => {
    const s = await controls();
    t.teardown(() => { s.client.emit('end', 'offline test complete'); });
    const original = s.raw.equip;
    let unsafeCalls = 0;
    s.raw.equip = async () => { unsafeCalls++; };
    if (lane === 'plugin') await t.throwsAsync(s.raw.tool.equipForBlock(s.block, {}), { message: /guard was replaced/ });
    else {
      const result = lane === 'legacy'
        ? await s.handlers.get('equip-item')!({ itemName: 'iron_pickaxe' })
        : await s.handlers.get('equip_item')!({ item: 'iron_pickaxe', destination: 'hand' });
      t.true(result.isError);
      t.regex(result.content[0].text, /guard was replaced/);
    }
    t.regex(s.authority.fence!, /guard was replaced/);
    t.is(unsafeCalls, 0);
    t.is(s.writes.length, 0);
    s.raw.equip = original;
    await t.throwsAsync(s.raw.tool.equipForBlock(s.block, {}), { message: /guard was replaced/ });
    t.is(s.writes.length, 0);
  });
}

test.serial('all installed inventory guard replacements are detected before a verified click', async t => {
  for (const name of guardedNames.filter(name => name !== 'equip')) {
    const s = await controls();
    t.teardown(() => { s.client.emit('end', 'offline test complete'); });
    s.raw[name] = () => { throw new Error('Unsafe overwritten method reached'); };
    await t.throwsAsync(s.raw.tool.equipForBlock(s.block, {}), { message: new RegExp(`guard was replaced \\(${name}\\)`) });
    t.truthy(s.authority.fence);
    t.is(s.writes.length, 0);
  }
});

test.serial('real clear_region cannot dig after swallowing an equip guard failure', async t => {
  const s = await controls();
  t.teardown(() => { s.client.emit('end', 'offline test complete'); });
  const equipForBlock = s.raw.tool.equipForBlock.bind(s.raw.tool);
  s.raw.tool.equipForBlock = async (...args: any[]) => {
    s.raw.equip = async () => { throw new Error('Overwritten native equip must not run'); };
    return equipForBlock(...args);
  };
  const result = await s.handlers.get('clear_region')!({ from: { x: 1, y: 64, z: 0 }, to: { x: 1, y: 64, z: 0 }, maxBlocks: 1 });
  t.true(result.isError);
  t.regex(result.content[0].text, /guard was replaced/);
  t.deepEqual(s.counts(), { digs: 0, placements: 0 });
  t.is(s.writes.length, 0);
  await t.throwsAsync(s.raw.tool.bot.placeBlock(s.block, new Vec3(0, 1, 0)), { message: /guard was replaced/ });
  t.deepEqual(s.counts(), { digs: 0, placements: 0 });
});

test.serial('cancelling real equipForBlock after one click fences and never sends a later click', async t => {
  const s = await controls();
  t.teardown(() => { s.client.emit('end', 'offline test complete'); });
  const action = s.handlers.get('equip_tool_for_block')!({ x: 1, y: 64, z: 0 });
  await nextTurn();
  t.is(s.clicks().length, 1);
  await s.complete.stop();
  const result = await action;
  t.true(result.isError);
  t.regex(result.content[0].text, /cancel|abort/i);
  t.truthy(s.authority.fence);
  t.is(s.clicks().length, 1);
  s.acknowledge(0);
  await nextTurn();
  t.is(s.clicks().length, 1);
  t.is(s.authority.listenerCount('change'), 0);
});

test.serial('guard loss during an acknowledged equip stops before the next click', async t => {
  const s = await controls();
  t.teardown(() => { s.client.emit('end', 'offline test complete'); });
  const action = s.handlers.get('equip_tool_for_block')!({ x: 1, y: 64, z: 0 });
  await nextTurn();
  t.is(s.clicks().length, 1);
  s.raw.moveSlotItem = async () => { throw new Error('Overwritten native move must not run'); };
  s.acknowledge(0);
  const result = await action;
  t.true(result.isError);
  t.regex(result.content[0].text, /guard was replaced/);
  t.regex(s.authority.fence!, /guard was replaced/);
  t.is(s.clicks().length, 1);
  t.is(s.authority.listenerCount('change'), 0);
});

test.serial('real auto-eat without food rejects before any packet and leaves the mutation lane ready', async t => {
  const s = await controls();
  t.teardown(() => { s.client.emit('end', 'offline test complete'); });
  const sequence = s.authority.sequence;
  const statusListeners = s.client.listenerCount('entity_status');
  const slotListeners = s.bot.inventory.listenerCount('updateSlot');
  const result = await s.handlers.get('autoeat_eat')!({});
  t.true(result.isError);
  t.regex(result.content[0].text, /No food specified and couldn't find a choice in inventory!/);
  t.deepEqual(s.writes, []);
  t.is(s.authority.sequence, sequence);
  t.is(s.authority.cursor, null);
  t.is(s.authority.fence, null);
  t.false(s.raw.autoEat.isEating);
  t.is(s.client.listenerCount('entity_status'), statusListeners);
  t.is(s.bot.inventory.listenerCount('updateSlot'), slotListeners);
  t.notThrows(() => s.authority.assertMutationReady());
  const next = await s.handlers.get('equip_item')!({ item: 'dirt', destination: 'hand' });
  t.not(next.isError, true);
  t.deepEqual(s.writes, [{ name: 'held_item_slot', packet: { slotId: 0 } }]);
  t.is(s.authority.fence, null);
});

for (const banned of ['default', 'configured']) {
  test.serial(`real auto-eat with only ${banned} banned food leaves no fence or packets`, async t => {
    const s = await controls();
    t.teardown(() => { s.client.emit('end', 'offline test complete'); });
    s.update(39, banned === 'default' ? 'poisonous_potato' : 'bread', 2);
    if (banned === 'configured') {
      const configured = await s.handlers.get('autoeat_configure')!({ bannedFood: ['bread'] });
      t.not(configured.isError, true);
    }
    const result = await s.handlers.get('autoeat_eat')!({});
    t.true(result.isError);
    t.regex(result.content[0].text, /No food specified/);
    t.deepEqual(s.writes, []);
    t.is(s.authority.fence, null);
    t.false(s.raw.autoEat.isEating);
    t.notThrows(() => s.authority.assertMutationReady());
  });
}

test.serial('real scheduled auto-eat at the hunger threshold stays ready without food and consumes later food', async t => {
  const s = await controls();
  t.teardown(() => { s.client.emit('end', 'offline test complete'); });
  s.bot.food = s.raw.autoEat.opts.minHunger;
  const enabled = await s.handlers.get('autoeat_set_enabled')!({ enabled: true });
  t.not(enabled.isError, true);
  s.bot.emit('physicsTick');
  await s.factory.runInActionLane(async () => {});
  const events = await s.handlers.get('get_events')!({ types: ['autoeat_error'] });
  const errors = JSON.parse(events.content[0].text).events;
  t.is(errors.length, 1);
  t.regex(errors[0].data.message, /No food specified/);
  t.deepEqual(s.writes, []);
  t.is(s.authority.fence, null);
  t.false(s.raw.autoEat.isEating);
  t.notThrows(() => s.authority.assertMutationReady());
  s.update(39, 'bread', 2);
  await new Promise(resolve => setTimeout(resolve, 1005));
  s.bot.emit('physicsTick');
  const settled = s.factory.runInActionLane(async () => {});
  await nextTurn();
  t.is(s.writes.filter(write => write.name === 'use_item').length, 1);
  s.finishEating();
  s.update(39, 'bread', 1);
  await settled;
  t.is(s.authority.getFrame(0).slots[39]?.count, 1);
  t.is(s.authority.fence, null);
  t.false(s.raw.autoEat.isEating);
  t.notThrows(() => s.authority.assertMutationReady());
});

for (const selection of ['name', 'id', 'explicit banned', 'missing fallback']) {
  test.serial(`real auto-eat retains upstream ${selection} selection semantics`, async t => {
    const s = await controls();
    t.teardown(() => { s.client.emit('end', 'offline test complete'); });
    const name = selection === 'explicit banned' ? 'poisonous_potato' : 'bread';
    s.update(39, name, 2);
    // An available higher ranked candidate must not replace an explicit choice.
    if (selection !== 'missing fallback') s.update(9, 'cooked_beef', 2);
    const food = selection === 'id' ? s.bot.registry.itemsByName[name].id : selection === 'missing fallback' ? 'absent_food' : name;
    let selected: any;
    s.raw.autoEat.once('eatStart', (request: any) => { selected = request.food; });
    const action = s.handlers.get('autoeat_eat')!({ food, equipOldItem: false });
    await nextTurn();
    t.is(selected?.name, name);
    t.is(s.writes.filter(write => write.name === 'use_item').length, 1);
    s.finishEating();
    s.update(39, name, 1);
    const result = await action;
    t.not(result.isError, true);
    t.is(s.authority.fence, null);
    t.is(s.authority.getFrame(0).slots[39]?.count, 1);
  });
}

test.serial('real auto-eat reuses upstream per-call ranking and configured offhand choice', async t => {
  const s = await controls();
  t.teardown(() => { s.client.emit('end', 'offline test complete'); });
  s.update(9, 'cooked_beef', 2);
  s.update(45, 'golden_carrot', 2);
  const configured = await s.handlers.get('autoeat_configure')!({ priority: 'foodPoints', offhand: true });
  t.not(configured.isError, true);
  let selected: any;
  s.raw.autoEat.once('eatStart', (request: any) => { selected = request; });
  const action = s.handlers.get('autoeat_eat')!({ priority: 'saturation', equipOldItem: false });
  await nextTurn();
  t.is(selected?.food.name, 'golden_carrot');
  t.true(selected?.offhand);
  t.is(s.writes.find(write => write.name === 'use_item')?.packet.hand, 1);
  s.finishEating();
  s.update(45, 'golden_carrot', 1);
  t.not((await action).isError, true);
  t.is(s.authority.fence, null);
});

test.serial('real auto-eat success retains the lane until exact authoritative consumption', async t => {
  const s = await controls();
  t.teardown(() => { s.client.emit('end', 'offline test complete'); });
  s.update(39, 'bread', 2);
  let settled = false, nextAction = false;
  const action = s.handlers.get('autoeat_eat')!({ equipOldItem: false });
  void action.then(() => { settled = true; });
  const next = s.factory.runInActionLane(async () => { nextAction = true; });
  await nextTurn();
  t.is(s.writes.filter(write => write.name === 'use_item').length, 1);
  s.bot.food = 20;
  s.finishEating();
  s.update(39, 'bread', 2); // Fresh but unchanged is not proof of consumption.
  s.update(9, 'dirt', 1); // Nor is an unrelated inventory update.
  await nextTurn();
  t.false(settled);
  t.false(nextAction);
  t.deepEqual(s.writes.map(write => write.name), ['block_dig', 'use_item']);
  s.update(39, 'bread', 1);
  const result = await action;
  await next;
  t.not(result.isError, true);
  t.true(JSON.parse(result.content[0].text).verification.confirmed);
  t.true(nextAction);
  t.false(s.bot.usingHeldItem);
  t.is(s.authority.fence, null);
  t.is(s.authority.listenerCount('change'), 0);
});

test.serial('real auto-eat post-use missing inventory confirmation still fences and never retries', async t => {
  const s = await controls();
  t.teardown(() => { s.client.emit('end', 'offline test complete'); });
  s.update(39, 'bread', 2);
  const action = s.handlers.get('autoeat_eat')!({ equipOldItem: false });
  await nextTurn();
  t.is(s.writes.filter(write => write.name === 'use_item').length, 1);
  s.finishEating();
  const result = await action;
  t.true(result.isError);
  t.regex(result.content[0].text, /timed out.*inventory removal/);
  t.is(s.authority.fence, 'Auto-eat consumption was not confirmed; inspect inventory before another mutation');
  t.false(s.bot.usingHeldItem);
  t.is(s.authority.listenerCount('change'), 0);
  const writes = [...s.writes];
  s.update(39, 'bread', 1); // Late truth must not clear an existing fence.
  const retry = await s.handlers.get('autoeat_eat')!({});
  t.true(retry.isError);
  t.regex(retry.content[0].text, /safety lock/);
  t.deepEqual(s.writes, writes);
});

test.serial('real auto-eat preflight preserves an existing fence before inspecting food', async t => {
  const s = await controls();
  t.teardown(() => { s.client.emit('end', 'offline test complete'); });
  s.authority.block('Prior uncertain operation');
  await t.throwsAsync(s.raw.autoEat.eat({}), { message: /Prior uncertain operation/ });
  t.is(s.authority.fence, 'Prior uncertain operation');
  t.deepEqual(s.writes, []);
  t.false(s.raw.autoEat.isEating);
});
