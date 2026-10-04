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
  raw.entity = { position: new Vec3(0, 64, 0), effects: {} };
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
  return { ...s, raw, slots, beforeIntegration, block, handlers, complete, clicks, acknowledge, counts: () => ({ digs, placements }) };
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
