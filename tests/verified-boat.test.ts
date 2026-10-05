import test from 'ava';
import sinon from 'sinon';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import type { Entity } from 'prismarine-entity';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { launchBoatVerified } from '../src/verified-boat.js';

const require = createRequire(import.meta.url);
function fixture() {
  const f = inventoryFixture([{ name: 'oak_boat', count: 1, slot: 36 }]);
  const Block = require('prismarine-block')(f.bot.registry);
  const controls: Record<string, boolean> = {};
  let obstructed = false;
  const target = new Vec3(2, 63, 0);
  Object.assign(f.bot, {
    entity: { id: 10, position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62 },
    health: 20, game: { dimension: 'overworld', gameMode: 'survival' },
    entities: {}, vehicle: null,
    blockAt: (point: Vec3) => {
      const p = point.floored();
      const b = Block.fromProperties(obstructed && p.y === 64 ? 'stone' : p.y === 63 ? 'water' : 'air', {}, 0);
      b.position = p; return b;
    },
    getControlState: (key: string) => controls[key] ?? false,
    canSeeBlock: () => true,
    lookAt: sinon.stub().resolves(), activateItem: sinon.stub(), deactivateItem: sinon.stub(),
    mount: sinon.stub(), dismount: sinon.stub()
  });
  f.bot.world = { raycast: () => f.bot.blockAt(target) } as never;
  function spawn(id = 30, name = 'boat', offset = new Vec3(0, 0, 0)) {
    const position = target.offset(0.5, 0.9, 0.5).plus(offset);
    const entity = { id, name, type: 'other', position, passengers: [] } as unknown as Entity;
    f.bot.entities[id] = entity;
    f.bot._client.emit('spawn_entity', { entityId: id, type: f.bot.registry.entitiesByName[name].id, x: position.x, y: position.y, z: position.z });
    f.bot.emit('entitySpawn', entity);
    return entity;
  }
  function consume() { f.slots[36] = null; f.sync(); }
  function mount() {
    (f.bot.mount as sinon.SinonStub).callsFake((entity: Entity) => {
      Object.assign(f.bot, { vehicle: entity });
      f.bot._client.emit('set_passengers', { entityId: entity.id, passengers: [f.bot.entity.id] });
    });
  }
  return { ...f, target, spawn, consume, mount, obstruct: () => { obstructed = true; } };
}

test('launch gates mounting on one fresh nearby boat and exact server debit', async t => {
  const f = fixture(); f.mount();
  (f.bot.activateItem as sinon.SinonStub).callsFake(() => { f.spawn(); f.consume(); });
  const result = await launchBoatVerified(f.bot, f.target, { mount: true, timeoutMs: 30 });
  t.true(result.confirmed); t.true(result.placementConfirmed); t.true(result.mountConfirmed);
  t.is(result.entityId, 30); t.is((f.bot.activateItem as sinon.SinonStub).callCount, 1);
  t.is((f.bot.mount as sinon.SinonStub).callCount, 1); t.falsy(f.authority.fence);
});

test('a local entity event or optimistic inventory cannot confirm boat placement', async t => {
  const f = fixture();
  (f.bot.activateItem as sinon.SinonStub).callsFake(() => {
    const entity = { id: 30, name: 'boat', position: f.target.offset(0.5, 0.9, 0.5) } as Entity;
    f.bot.entities[30] = entity; f.bot.emit('entitySpawn', entity); f.bot.inventory.slots[36] = null;
  });
  await t.throwsAsync(launchBoatVerified(f.bot, f.target, { mount: true, timeoutMs: 5 }), { message: /not confirmed/i });
  t.false((f.bot.mount as sinon.SinonStub).called); t.truthy(f.authority.fence);
  t.is(f.bot._client.listenerCount('spawn_entity'), 0);
});

test('debit alone, unrelated spawns and ambiguous boats fence without a second use', async t => {
  for (const scenario of ['debit', 'unrelated', 'ambiguous'] as const) {
    const f = fixture();
    (f.bot.activateItem as sinon.SinonStub).callsFake(() => {
      f.consume();
      if (scenario === 'unrelated') f.spawn(30, 'boat', new Vec3(8, 0, 0));
      if (scenario === 'ambiguous') { f.spawn(30); f.spawn(31); }
    });
    await t.throwsAsync(launchBoatVerified(f.bot, f.target, { mount: true, timeoutMs: 5 }));
    t.true(!!f.authority.fence); t.false((f.bot.mount as sinon.SinonStub).called);
    t.is((f.bot.activateItem as sinon.SinonStub).callCount, 1);
  }
});

test('occupied water/headroom is rejected before an item-use request or fence', async t => {
  const f = fixture(); f.obstruct();
  await t.throwsAsync(launchBoatVerified(f.bot, f.target, { timeoutMs: 5 }), { message: /clear|water|room/i });
  t.false((f.bot.activateItem as sinon.SinonStub).called); t.falsy(f.authority.fence);
});

test('cancellation after placement issue keeps the inventory fence and never mounts', async t => {
  const f = fixture(); const controller = new AbortController();
  (f.bot.activateItem as sinon.SinonStub).callsFake(() => { controller.abort(); });
  await t.throwsAsync(launchBoatVerified(f.bot, f.target, { mount: true, signal: controller.signal, timeoutMs: 100 }));
  t.truthy(f.authority.fence); t.false((f.bot.mount as sinon.SinonStub).called);
  t.true((f.bot.deactivateItem as sinon.SinonStub).called);
});

test('unconfirmed mount reports placed boat without repeating placement or dismounting', async t => {
  const f = fixture();
  (f.bot.activateItem as sinon.SinonStub).callsFake(() => { f.spawn(); f.consume(); });
  const result = await launchBoatVerified(f.bot, f.target, { mount: true, timeoutMs: 5 });
  t.true(result.placementConfirmed); t.false(result.mountConfirmed); t.false(result.confirmed);
  t.falsy(f.authority.fence); t.false((f.bot.dismount as sinon.SinonStub).called);
  t.is((f.bot.activateItem as sinon.SinonStub).callCount, 1);
});

test('cancellation while preparing look must not issue placement', async t => {
  const f = fixture(); const controller = new AbortController();
  (f.bot.lookAt as sinon.SinonStub).callsFake(async () => { controller.abort(); });
  await t.throwsAsync(launchBoatVerified(f.bot, f.target, { signal: controller.signal }));
  t.false((f.bot.activateItem as sinon.SinonStub).called); t.falsy(f.authority.fence);
});

for (const scenario of ['refund', 'unrelated-restored'] as const) test(`a transient ${scenario} cannot be hidden by the final placement snapshot`, async t => {
  const f = fixture(); const original = f.slots[36];
  (f.bot.activateItem as sinon.SinonStub).callsFake(() => {
    f.spawn(); f.consume();
    if (scenario === 'refund') { f.slots[36] = original; f.sync(); f.consume(); }
    else { f.slots[9] = original; f.sync(); f.slots[9] = null; f.sync(); }
  });
  await t.throwsAsync(launchBoatVerified(f.bot, f.target, { mount: true, timeoutMs: 5 }), { message: /reversed|Unrelated/ });
  t.truthy(f.authority.fence); t.false((f.bot.mount as sinon.SinonStub).called);
});

test('a closer raycast hit prevents using the held boat on another cell', async t => {
  const f = fixture(); f.bot.world.raycast = () => f.bot.blockAt(new Vec3(1, 63, 0)) as never;
  await t.throwsAsync(launchBoatVerified(f.bot, f.target, { timeoutMs: 5 }), { message: /first visible water hit/ });
  t.false((f.bot.activateItem as sinon.SinonStub).called); t.falsy(f.authority.fence);
});
