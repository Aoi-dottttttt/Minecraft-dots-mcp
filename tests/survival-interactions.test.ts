import test from 'ava';
import { createRequire } from 'node:module';
import sinon from 'sinon';
import { Vec3 } from 'vec3';
import type { Block } from 'prismarine-block';
import type { Entity } from 'prismarine-entity';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import { ToolFactory } from '../src/tool-factory.js';
import { registerBlockTools } from '../src/tools/block-tools.js';
import { installPlacementProvenance } from '../src/placement-provenance.js';
import { equipVerified } from '../src/verified-inventory.js';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { registerInteractionTools } from '../src/tools/interaction-tools.js';
import {
  activateBlockVerified, dismountVerified, farmBlockVerified, inspectInteractionBlock,
  mountVerified, selectInteractionItem, setBedRespawn, sleepInBedVerified, steerVehicleBounded,
  stopHeldItem, useHeldItemBounded, useItemOnBlockVerified, useOnEntityVerified, wakeVerified
} from '../src/survival-interactions.js';

const require = createRequire(import.meta.url);
function fixture(items: Array<{ name: string; count: number; slot: number }> = []) {
  const inventory = inventoryFixture(items);
  const bot = inventory.bot;
  const blocks = new Map<string, Block>();
  const BlockType = require('prismarine-block')(bot.registry);
  const makeBlock = (name: string, properties: Record<string, unknown> = {}, position = new Vec3(1, 64, 0)): Block => {
    const type = bot.registry.blocksByName[name];
    for (let stateId = type.minStateId; stateId <= type.maxStateId; stateId++) {
      const block = BlockType.fromStateId(stateId, 0) as Block;
      if (Object.entries(properties).every(([key, value]) => String(block.getProperties()[key]) === String(value))) {
        block.position = position;
        return block;
      }
    }
    throw new Error(`Unknown ${name} properties`);
  };
  const setBlock = (name: string, properties: Record<string, unknown> = {}, position = new Vec3(1, 64, 0)): Block => {
    const block = makeBlock(name, properties, position);
    blocks.set(position.toString(), block);
    return block;
  };
  Object.assign(bot, {
    entity: { id: 10, position: new Vec3(0, 64, 0), height: 1.8, eyeHeight: 1.62 }, health: 20,
    game: { dimension: 'overworld', gameMode: 'survival' }, entities: {}, vehicle: null, isSleeping: false,
    blockAt: (position: Vec3) => blocks.get(position.toString()) ?? makeBlock('air', {}, position),
    canSeeBlock: sinon.stub().returns(true), getControlState: sinon.stub().returns(false),
    activateBlock: sinon.stub().resolves(), activateItem: sinon.stub(), deactivateItem: sinon.stub(),
    lookAt: sinon.stub().resolves(), useOn: sinon.stub(), mount: sinon.stub(), dismount: sinon.stub(), moveVehicle: sinon.stub(),
    isABed: (block: Block) => block.name.endsWith('_bed'), sleep: sinon.stub().resolves(), wake: sinon.stub().resolves()
  });
  const serverBlock = (block: Block) => { blocks.set(block.position.toString(), block); bot._client.emit('block_change', { location: block.position, type: block.stateId }); };
  const addEntity = (name = 'cow', id = 2, type = 'mob') => {
    const entity = { id, name, type, position: new Vec3(1, 64, 0) } as Entity;
    bot.entities[id] = entity;
    return entity;
  };
  return { ...inventory, setBlock, makeBlock, serverBlock, addEntity };
}

test('inspection exposes boolean door properties without modifying the world', t => {
  const { bot, setBlock } = fixture();
  setBlock('oak_door', { open: false });
  const inspected = inspectInteractionBlock(bot, { x: 1, y: 64, z: 0 });
  t.is((inspected.properties as Record<string, unknown>).open, false);
  t.false((bot.activateBlock as sinon.SinonStub).called);
});

test('door desired state is idempotent and actual toggle requires matching raw evidence', async t => {
  const { bot, setBlock, makeBlock, serverBlock } = fixture();
  setBlock('oak_door', { open: false });
  const already = await activateBlockVerified(bot, { x: 1, y: 64, z: 0 }, { desiredState: 'closed' });
  t.true(already.confirmed); t.false(already.requestIssued);
  (bot.activateBlock as sinon.SinonStub).callsFake(async () => serverBlock(makeBlock('oak_door', { open: true })));
  const opened = await activateBlockVerified(bot, { x: 1, y: 64, z: 0 }, { desiredState: 'open', timeoutMs: 10 });
  t.true(opened.confirmed); t.true(opened.requestIssued);
  t.is((bot.activateBlock as sinon.SinonStub).callCount, 1);
});

test('optimistic block events and wrong raw states do not confirm a door', async t => {
  const { bot, setBlock, makeBlock } = fixture();
  const closed = setBlock('oak_door', { open: false });
  (bot.activateBlock as sinon.SinonStub).callsFake(async () => {
    bot.emit('blockUpdate', closed, makeBlock('oak_door', { open: true }));
    bot._client.emit('block_change', { location: closed.position, type: closed.stateId });
  });
  const outcome = await activateBlockVerified(bot, closed.position, { desiredState: 'open', timeoutMs: 5 });
  t.false(outcome.confirmed); t.true(outcome.requestIssued);
  t.is(bot._client.listenerCount('block_change'), 0);
});

test('iron doors cannot be toggled or broken as a fallback', async t => {
  const { bot, setBlock } = fixture();
  const iron = setBlock('iron_door', { open: false });
  await t.throwsAsync(activateBlockVerified(bot, iron.position, { desiredState: 'open' }), { message: /require redstone/ });
  t.false((bot.activateBlock as sinon.SinonStub).called);
});

test('trapdoors, gates, levers and buttons use matching state properties', async t => {
  for (const [name, property, desired] of [['oak_trapdoor', 'open', 'open'], ['oak_fence_gate', 'open', 'open'], ['lever', 'powered', 'on'], ['stone_button', 'powered', 'on']] as const) {
    const { bot, setBlock, makeBlock, serverBlock } = fixture();
    const initial = setBlock(name, { [property]: false });
    (bot.activateBlock as sinon.SinonStub).callsFake(async () => serverBlock(makeBlock(name, { [property]: true })));
    const outcome = await activateBlockVerified(bot, initial.position, { desiredState: desired, timeoutMs: 5 });
    t.true(outcome.confirmed);
  }
});

test('bad cursor, noninteger coordinates, reach and visibility reject before interaction', async t => {
  const { bot, setBlock } = fixture();
  setBlock('oak_door', { open: false });
  await t.throwsAsync(activateBlockVerified(bot, new Vec3(1, 64, 0), { cursor: { x: 2, y: 1, z: 0.5 } }), { message: /between 0 and 1/ });
  await t.throwsAsync(activateBlockVerified(bot, new Vec3(1, 64, 0), { cursor: { x: 0.5, y: 0.5, z: 0.5 } }), { message: /selected block face/ });
  await t.throwsAsync(activateBlockVerified(bot, new Vec3(1.5, 64, 0)), { message: /safe integers/ });
  setBlock('oak_door', { open: false }, new Vec3(12, 64, 0));
  await t.throwsAsync(activateBlockVerified(bot, new Vec3(12, 64, 0)), { message: /outside survival interaction reach/ });
  (bot.canSeeBlock as sinon.SinonStub).returns(false);
  await t.throwsAsync(activateBlockVerified(bot, new Vec3(1, 64, 0)), { message: /not visible/ });
  t.false((bot.activateBlock as sinon.SinonStub).called);
});

test('generic block request without a declared expected effect stays unconfirmed', async t => {
  const { bot, setBlock } = fixture();
  const block = setBlock('crafting_table');
  const outcome = await useItemOnBlockVerified(bot, block.position);
  t.true(outcome.requestIssued); t.false(outcome.confirmed);
});

test('wheat seeds map to wheat block and authoritative exact slot selection', async t => {
  const { bot, setBlock, makeBlock, serverBlock, authority } = fixture([{ name: 'wheat_seeds', count: 4, slot: 9 }]);
  const farmland = setBlock('farmland');
  (bot.activateBlock as sinon.SinonStub).callsFake(async () => serverBlock(makeBlock('wheat', { age: 0 }, farmland.position.offset(0, 1, 0))));
  const outcome = await farmBlockVerified(bot, farmland.position, { action: 'plant', inventorySlot: 9, timeoutMs: 10 });
  t.true(outcome.confirmed);
  t.is(authority.getFrame(0).slots[36]?.name, 'wheat_seeds');
});

test('duplicate item names require explicit slot unless already held', async t => {
  const { bot } = fixture([{ name: 'wheat_seeds', count: 4, slot: 9 }, { name: 'wheat_seeds', count: 7, slot: 10 }]);
  await t.throwsAsync(selectInteractionItem(bot, { itemName: 'wheat_seeds' }), { message: /Multiple.*inventorySlot/ });
  const chosen = await selectInteractionItem(bot, { itemName: 'wheat_seeds', inventorySlot: 10 });
  t.is(chosen.count, 7);
});

test('tilling uses hoe and confirms farmland rather than held item type', async t => {
  const { bot, setBlock, makeBlock, serverBlock } = fixture([{ name: 'iron_hoe', count: 1, slot: 36 }]);
  const soil = setBlock('dirt');
  (bot.activateBlock as sinon.SinonStub).callsFake(async () => serverBlock(makeBlock('farmland')));
  const outcome = await farmBlockVerified(bot, soil.position, { action: 'till', timeoutMs: 5 });
  t.true(outcome.confirmed);
});

test('bonemeal without target state change remains unconfirmed', async t => {
  const { bot, setBlock } = fixture([{ name: 'bone_meal', count: 1, slot: 36 }]);
  const crop = setBlock('wheat', { age: 7 });
  const outcome = await farmBlockVerified(bot, crop.position, { action: 'bonemeal', timeoutMs: 5 });
  t.false(outcome.confirmed);
});

test('bucket collection uses public item activation and requires fluid removal', async t => {
  const { bot, setBlock, makeBlock, serverBlock } = fixture([{ name: 'bucket', count: 1, slot: 36 }]);
  const water = setBlock('water', { level: 0 });
  (bot.activateItem as sinon.SinonStub).callsFake(() => serverBlock(makeBlock('air')));
  const outcome = await farmBlockVerified(bot, water.position, { action: 'bucket', timeoutMs: 5 });
  t.true(outcome.confirmed);
  t.true((bot.activateItem as sinon.SinonStub).calledOnce);
  t.true((bot.deactivateItem as sinon.SinonStub).calledOnce);
  t.false((bot.activateBlock as sinon.SinonStub).called);
});

test('held use handles offhand and always stops even when cancelled', async t => {
  const { bot } = fixture([{ name: 'shield', count: 1, slot: 45 }]);
  const controller = new AbortController();
  (bot.activateItem as sinon.SinonStub).callsFake(() => setTimeout(() => controller.abort(), 2));
  await t.throwsAsync(useHeldItemBounded(bot, { offHand: true, durationMs: 30, signal: controller.signal }), { message: /cancelled/ });
  t.true((bot.activateItem as sinon.SinonStub).calledWith(true));
  t.true((bot.deactivateItem as sinon.SinonStub).calledOnce);
});

test('held use has a finite limit and cleanup bypasses mutation fence', async t => {
  const { bot, authority } = fixture([{ name: 'shield', count: 1, slot: 36 }]);
  await t.throwsAsync(useHeldItemBounded(bot, { durationMs: 100000 }), { message: /between 1 and 5000/ });
  const outcome = await useHeldItemBounded(bot, { durationMs: 3 });
  t.false(outcome.confirmed); t.true(outcome.stopped as boolean);
  authority.block('Test fence');
  t.notThrows(() => stopHeldItem(bot));
});

test('all bed paths reject explosive dimensions before any activation', async t => {
  const { bot, setBlock } = fixture();
  const bed = setBlock('red_bed');
  bot.game.dimension = 'the_nether';
  await t.throwsAsync(sleepInBedVerified(bot, bed.position), { message: /Overworld/ });
  await t.throwsAsync(setBedRespawn(bot, bed.position), { message: /Overworld/ });
  await t.throwsAsync(useItemOnBlockVerified(bot, bed.position), { message: /Overworld/ });
  t.false((bot.activateBlock as sinon.SinonStub).called); t.false((bot.sleep as sinon.SinonStub).called);
});

test('sleep and wake require server-derived state events', async t => {
  const { bot, setBlock } = fixture();
  const bed = setBlock('red_bed');
  (bot.sleep as sinon.SinonStub).callsFake(async () => { bot.isSleeping = true; bot.emit('sleep'); });
  t.true((await sleepInBedVerified(bot, bed.position, { timeoutMs: 5 })).confirmed);
  (bot.wake as sinon.SinonStub).callsFake(async () => { bot.isSleeping = false; bot.emit('wake'); });
  t.true((await wakeVerified(bot, { timeoutMs: 5 })).confirmed);
});

test('daytime bed use distinguishes attempted from server-confirmed respawn', async t => {
  const { bot, setBlock } = fixture();
  const bed = setBlock('red_bed');
  t.false((await setBedRespawn(bot, bed.position, { timeoutMs: 5 })).confirmed);
  (bot.activateBlock as sinon.SinonStub).callsFake(async () => bot.emit('message', { json: { translate: 'block.minecraft.set_spawn' } } as never, 'system'));
  t.true((await setBedRespawn(bot, bed.position, { timeoutMs: 5 })).confirmed);
  t.false((bot.sleep as sinon.SinonStub).called);
});

test('player and remote entity use is rejected before issuing a request', async t => {
  const { bot, addEntity } = fixture([{ name: 'wheat', count: 1, slot: 36 }]);
  addEntity('player', 2, 'player');
  await t.throwsAsync(useOnEntityVerified(bot, 2), { message: /players/ });
  addEntity('cow', 3).position = new Vec3(20, 64, 0);
  await t.throwsAsync(useOnEntityVerified(bot, 3), { message: /outside survival interaction reach/ });
  t.false((bot.useOn as sinon.SinonStub).called);
});

test('animal use does not infer effect from packet issuance or unrelated entity status', async t => {
  const { bot, addEntity } = fixture([{ name: 'wheat', count: 1, slot: 36 }]);
  addEntity();
  (bot.useOn as sinon.SinonStub).callsFake(() => bot._client.emit('entity_status', { entityId: 3, entityStatus: 18 }));
  t.false((await useOnEntityVerified(bot, 2, { timeoutMs: 5 })).confirmed);
  (bot.useOn as sinon.SinonStub).callsFake(() => bot._client.emit('entity_status', { entityId: 2, entityStatus: 18 }));
  t.true((await useOnEntityVerified(bot, 2, { timeoutMs: 5 })).confirmed);
});

test('mount requires matching passenger evidence and does not trust local mount mutation', async t => {
  const { bot, addEntity } = fixture();
  const boat = addEntity('oak_boat');
  (bot.mount as sinon.SinonStub).callsFake(() => bot.emit('mount'));
  t.false((await mountVerified(bot, boat.id, { timeoutMs: 5 })).confirmed);
  (bot.mount as sinon.SinonStub).callsFake(() => bot._client.emit('set_passengers', { entityId: boat.id, passengers: [bot.entity.id] }));
  t.true((await mountVerified(bot, boat.id, { timeoutMs: 5 })).confirmed);
  Object.assign(bot, { vehicle: boat });
  (bot.dismount as sinon.SinonStub).callsFake(() => bot._client.emit('set_passengers', { entityId: boat.id, passengers: [] }));
  t.true((await dismountVerified(bot, { timeoutMs: 5 })).confirmed);
  t.true((await dismountVerified(bot, { timeoutMs: 5 })).confirmed);
  t.true((bot.dismount as sinon.SinonStub).calledOnce);
});

test('steering reports only server movement and releases on cancellation', async t => {
  const { bot, addEntity } = fixture();
  const boat = addEntity('oak_boat');
  Object.assign(bot, { vehicle: boat });
  t.false((await steerVehicleBounded(bot, { left: 0, forward: 1, durationMs: 3 })).confirmed);
  const controller = new AbortController();
  (bot.moveVehicle as sinon.SinonStub).callsFake((left: number, forward: number) => { if (left || forward) setTimeout(() => controller.abort(), 2); });
  await t.throwsAsync(steerVehicleBounded(bot, { left: 0, forward: 1, durationMs: 30, signal: controller.signal }), { message: /cancelled/ });
  t.deepEqual((bot.moveVehicle as sinon.SinonStub).lastCall.args, [0, 0]);
});

test('pre-aborted requests never issue world/entity actions', async t => {
  const { bot, setBlock } = fixture();
  const block = setBlock('oak_door', { open: false });
  const controller = new AbortController(); controller.abort();
  await t.throwsAsync(activateBlockVerified(bot, block.position, { signal: controller.signal }));
  t.false((bot.activateBlock as sinon.SinonStub).called);
});

test('new tools register separately and validation precedes actions', async t => {
  const { bot } = fixture();
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  registerInteractionTools(new ToolFactory(server, connection), () => bot);
  const registrations = (server.tool as sinon.SinonStub).getCalls();
  t.is(registrations.length, 14);
  t.is(new Set(registrations.map(call => call.args[0])).size, 14);
  const held = registrations.find(call => call.args[0] === 'use-held-item')!;
  const outcome = await held.args[3]({ durationMs: 100000 });
  t.true(outcome.isError);
  t.false((bot.activateItem as sinon.SinonStub).called);
});


test('exactSource equips requested storage stack instead of an identical hotbar stack', async t => {
  const { bot, authority } = fixture([{ name: 'wheat_seeds', count: 4, slot: 9 }, { name: 'wheat_seeds', count: 7, slot: 36 }]);
  await equipVerified(bot, 9, 'hand', 30, { exactSource: true });
  t.is(authority.getFrame(0).slots[36]?.count, 4);
  t.is(authority.getFrame(0).slots[9]?.count, 7);
});

test('exactSource selects requested hotbar slot and ordinary equip retains compatible behavior', async t => {
  const { bot } = fixture([{ name: 'wheat_seeds', count: 4, slot: 40 }, { name: 'wheat_seeds', count: 7, slot: 36 }]);
  await equipVerified(bot, 40, 'hand', 30, { exactSource: true });
  t.is(bot.quickBarSlot, 4);
  await equipVerified(bot, 40, 'hand', 30);
  t.is(bot.quickBarSlot, 0);
});

test('explicit item slot honors an exact offhand transfer even for matching items', async t => {
  const { bot, authority } = fixture([{ name: 'wheat', count: 4, slot: 9 }, { name: 'wheat', count: 7, slot: 45 }]);
  await selectInteractionItem(bot, { inventorySlot: 9 }, true, { timeoutMs: 30 });
  t.is(authority.getFrame(0).slots[45]?.count, 4);
  t.is(authority.getFrame(0).slots[9]?.count, 7);
});

test('cancellation after initial look prevents deferred block activation', async t => {
  const { bot, setBlock } = fixture();
  const block = setBlock('oak_door', { open: false });
  const controller = new AbortController();
  (bot.lookAt as sinon.SinonStub).callsFake(async () => controller.abort());
  await t.throwsAsync(activateBlockVerified(bot, block.position, { signal: controller.signal }));
  t.false((bot.activateBlock as sinon.SinonStub).called);
});


test('already-held caller keeps its exact hotbar stack rather than an implicit match', async t => {
  const { bot } = fixture([{ name: 'wheat', count: 4, slot: 40 }, { name: 'wheat', count: 7, slot: 36 }]);
  bot.quickBarSlot = 4;
  const item = await selectInteractionItem(bot, {});
  t.is(bot.quickBarSlot, 4);
  t.is(item.count, 4);
});

test('block server corrections cannot masquerade as a completed toggle', async t => {
  const { bot, setBlock, makeBlock, serverBlock } = fixture();
  const closed = setBlock('oak_door', { open: false });
  (bot.activateBlock as sinon.SinonStub).callsFake(async () => { serverBlock(makeBlock('oak_door', { open: true })); serverBlock(closed); });
  const outcome = await activateBlockVerified(bot, closed.position, { desiredState: 'open', timeoutMs: 5 });
  t.false(outcome.confirmed);
});

test('bed respawn ignores player chat that imitates a server translation', async t => {
  const { bot, setBlock } = fixture();
  const bed = setBlock('red_bed');
  (bot.activateBlock as sinon.SinonStub).callsFake(async () => bot.emit('message', { json: { translate: 'block.minecraft.set_spawn' } } as never, 'chat'));
  t.false((await setBedRespawn(bot, bed.position, { timeoutMs: 5 })).confirmed);
});


test('server attachment correction prevents an optimistic mount result', async t => {
  const { bot, addEntity } = fixture();
  const boat = addEntity('oak_boat');
  (bot.mount as sinon.SinonStub).callsFake(() => {
    bot._client.emit('set_passengers', { entityId: boat.id, passengers: [bot.entity.id] });
    bot._client.emit('set_passengers', { entityId: boat.id, passengers: [] });
  });
  t.false((await mountVerified(bot, boat.id, { timeoutMs: 5 })).confirmed);
});

function placementFixture() {
  const s = fixture([{ name: 'stone_brick_wall', count: 4, slot: 36 }]);
  const support = s.setBlock('stone', {}, new Vec3(1, 63, 0));
  const target = support.position.offset(0, 1, 0);
  const ledger = installPlacementProvenance(s.bot);
  const decrement = () => { s.slots[36] = { ...s.slots[36], count: 3 }; s.sync(); };
  const place = () => s.serverBlock(s.makeBlock('stone_brick_wall', {}, target));
  const run = (extra = {}) => useItemOnBlockVerified(s.bot, support.position, { expect: { position: target, name: 'stone_brick_wall' }, timeoutMs: 30, ...extra });
  return { ...s, support, target, ledger, decrement, place, run };
}

test('generic verified wall placement records the same source used by guarded mining', async t => {
  const s = placementFixture();
  (s.bot.activateBlock as sinon.SinonStub).callsFake(async () => { s.place(); s.decrement(); });
  const result = await s.run();
  t.true(result.confirmed); t.true(s.ledger.has(s.target));
  t.deepEqual(s.ledger.entries(), [[s.target.toString(), 'stone_brick_wall']]);
});

for (const order of ['inventory-first', 'block-first', 'delayed-inventory'] as const) {
  test(`wall provenance accepts raw proof with ${order}`, async t => {
    const s = placementFixture();
    (s.bot.activateBlock as sinon.SinonStub).callsFake(async () => {
      if (order === 'inventory-first') { s.decrement(); s.place(); }
      else { s.place(); if (order === 'delayed-inventory') setImmediate(s.decrement); else s.decrement(); }
    });
    const result = await s.run(); t.true(result.confirmed); t.true(result.placementRecorded); t.true(s.ledger.has(s.target));
    t.is(s.authority.listenerCount('change'), 0); t.is(s.ledger.listenerCount('block'), 0); t.is(s.ledger.listenerCount('invalidate'), 0);
  });
}

for (const fault of ['no-inventory', 'no-block-packet', 'optimistic-block', 'wrong-debit', 'wrong-item', 'unrelated-slot', 'debit-then-repair', 'unrelated-slot-then-repair', 'cursor', 'dimension', 'unload'] as const) {
  test(`wall provenance rejects ${fault} without granting another mining permission`, async t => {
    const s = placementFixture();
    (s.bot.activateBlock as sinon.SinonStub).callsFake(async () => {
      if (fault === 'optimistic-block') {
        const old = s.bot.blockAt(s.target); const placed = s.setBlock('stone_brick_wall', {}, s.target); s.bot.emit('blockUpdate', old, placed);
      } else if (fault !== 'no-block-packet') s.place();
      if (fault !== 'no-inventory') {
        if (fault === 'wrong-debit' || fault === 'debit-then-repair') { s.slots[36] = { ...s.slots[36], count: 2 }; s.sync(); }
        else if (fault === 'wrong-item') { s.slots[36] = { ...s.slots[36], type: s.bot.registry.itemsByName.oak_planks.id, count: 3 }; s.sync(); }
        else s.decrement();
      }
      if (fault === 'unrelated-slot' || fault === 'unrelated-slot-then-repair') { s.slots[9] = { ...s.slots[36], count: 1 }; s.sync(); if (fault.endsWith('repair')) { s.slots[9] = null; s.sync(); } }
      if (fault === 'debit-then-repair') s.decrement();
      if (fault === 'cursor') s.bot._client.emit('set_slot', { windowId: 255, slot: -1, stateId: 9, item: s.authority.raw({ ...s.authority.getFrame(0).slots[36]!, count: 1 }) });
      if (fault === 'dimension') s.bot.game.dimension = 'the_nether';
      if (fault === 'unload') s.bot._client.emit('unload_chunk', { chunkX: 0, chunkZ: 0 });
    });
    await s.run(); t.false(s.ledger.has(s.target)); t.deepEqual(s.ledger.entries(), []);
    t.is(s.authority.fence, null); t.is(s.authority.listenerCount('change'), 0); t.is(s.ledger.listenerCount('block'), 0);
  });
}

test('an already present wall cannot become ours through a state change', async t => {
  const s = placementFixture(); s.setBlock('stone_brick_wall', {}, s.target);
  (s.bot.activateBlock as sinon.SinonStub).callsFake(async () => { s.serverBlock(s.makeBlock('stone_brick_wall', { east: 'low' }, s.target)); s.decrement(); });
  const outcome = await s.run({ expect: { position: s.target, name: 'stone_brick_wall', properties: { east: 'low' } } });
  t.true(outcome.confirmed); t.false(s.ledger.has(s.target));
});

test('caller expectation cannot claim a remote neighboring block or a different held material', async t => {
  for (const mode of ['remote', 'wrong-held']) {
    const s = placementFixture(); const target = mode === 'remote' ? s.target.offset(1, 0, 0) : s.target;
    if (mode === 'wrong-held') { s.slots[36].type = s.bot.registry.itemsByName.oak_planks.id; s.sync(); }
    (s.bot.activateBlock as sinon.SinonStub).callsFake(async () => { s.serverBlock(s.makeBlock('stone_brick_wall', {}, target)); s.decrement(); });
    const outcome = await s.run({ expect: { position: target, name: 'stone_brick_wall' } });
    t.true(outcome.confirmed); t.false(s.ledger.has(target));
  }
});

for (const invalidation of ['air-then-same-wall', 'different-material', 'dimension', 'respawn', 'end', 'chunk-unload', 'chunk-replacement', 'multi-block-change'] as const) {
  test(`confirmed wall source expires on ${invalidation}`, async t => {
    const s = placementFixture(); (s.bot.activateBlock as sinon.SinonStub).callsFake(async () => { s.place(); s.decrement(); });
    await s.run(); t.true(s.ledger.has(s.target));
    switch (invalidation) {
      case 'air-then-same-wall': s.serverBlock(s.makeBlock('air', {}, s.target)); s.place(); break;
      case 'different-material': s.serverBlock(s.makeBlock('oak_planks', {}, s.target)); break;
      case 'dimension': s.bot.game.dimension = 'the_nether'; break;
      case 'respawn': s.bot._client.emit('respawn'); break;
      case 'end': s.bot.emit('end', 'synthetic disconnect'); break;
      case 'chunk-unload': s.bot._client.emit('unload_chunk', { chunkX: 0, chunkZ: 0 }); break;
      case 'chunk-replacement': s.bot._client.emit('map_chunk', { x: 0, z: 0 }); break;
      case 'multi-block-change': s.bot._client.emit('multi_block_change', { chunkCoordinates: { x: 0, y: 4, z: 0 }, records: [(s.bot.registry.blocksByName.air.minStateId << 12) | 256] }); break;
    }
    t.false(s.ledger.has(s.target));
  });
}

test('wall connection-state updates and unrelated chunks preserve continuously observed source', async t => {
  const s = placementFixture(); (s.bot.activateBlock as sinon.SinonStub).callsFake(async () => { s.place(); s.decrement(); });
  await s.run(); s.serverBlock(s.makeBlock('stone_brick_wall', { east: 'low' }, s.target));
  s.bot._client.emit('map_chunk', { x: 8, z: 8 }); s.bot._client.emit('unload_chunk', { chunkX: 9, chunkZ: 9 });
  t.true(s.ledger.has(s.target));
});

test('cancelled placement keeps listeners bounded and does not authorize the placed block', async t => {
  const s = placementFixture(); const controller = new AbortController();
  (s.bot.activateBlock as sinon.SinonStub).callsFake(async () => { s.place(); s.decrement(); controller.abort(); });
  await t.throwsAsync(s.run({ signal: controller.signal })); t.false(s.ledger.has(s.target));
  t.is(s.authority.listenerCount('change'), 0); t.is(s.ledger.listenerCount('block'), 0); t.is(s.ledger.listenerCount('invalidate'), 0);
});

test('legacy place-block also records independently confirmed source without parsing success text', async t => {
  const s = placementFixture(); const server = { tool: sinon.stub() } as unknown as McpServer;
  const factory = new ToolFactory(server, { checkConnectionAndReconnect: async () => ({ connected: true }) } as BotConnection);
  Object.defineProperty(s.bot, 'heldItem', { get: () => s.authority.getFrame(0).slots[36] });
  s.bot.placeBlock = async () => { s.place(); s.decrement(); };
  registerBlockTools(factory, () => s.bot);
  const call = (server.tool as sinon.SinonStub).getCalls().find(call => call.args[0] === 'place-block')!.args[3];
  const outcome = await call(s.target); t.falsy(outcome.isError); t.true(s.ledger.has(s.target));
});

test('a matching block update before the actual block-use call cannot grant placement provenance', async t => {
  const s = placementFixture();
  (s.bot.lookAt as sinon.SinonStub).callsFake(async () => { s.place(); s.decrement(); });
  const outcome = await s.run();
  t.true(outcome.confirmed); t.false(outcome.placementRecorded); t.false(s.ledger.has(s.target));
});

for (const repeatDebit of [false, true]) {
  test(`an exact placement debit followed by a refund cannot be reused (repeat debit: ${repeatDebit})`, async t => {
    const s = placementFixture();
    (s.bot.activateBlock as sinon.SinonStub).callsFake(async () => {
      s.place(); s.decrement();
      s.slots[36] = { ...s.slots[36], count: 4 }; s.sync();
      if (repeatDebit) s.decrement();
    });
    const outcome = await s.run();
    t.true(outcome.confirmed); t.false(outcome.placementRecorded); t.false(s.ledger.has(s.target));
  });
}
