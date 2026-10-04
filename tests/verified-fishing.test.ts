import test from 'ava';
import sinon from 'sinon';
import { Vec3 } from 'vec3';
import type { Entity } from 'prismarine-entity';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { fishOnceVerified } from '../src/verified-fishing.js';

function fixture() {
  const inventory = inventoryFixture([{ name: 'fishing_rod', count: 1, slot: 36 }]);
  const bot = inventory.bot;
  Object.assign(bot, { entity: { id: 10, position: new Vec3(0, 64, 0) }, entities: {}, activateItem: sinon.stub(), deactivateItem: sinon.stub(), fish: sinon.stub().throws(new Error('Native unbounded fish must never be called')) });
  const bobberType = bot.registry.entitiesByName.fishing_bobber.id;
  const spawn = (id = 20, owner: number | undefined = 10, position = new Vec3(2, 64, 0)) => {
    bot.entities[id] = { id, name: 'fishing_bobber', entityType: bobberType, position } as Entity;
    bot._client.emit('spawn_entity', { entityId: id, type: bobberType, objectData: owner, x: position.x, y: position.y, z: position.z });
  };
  const bite = (x = 2, z = 0) => bot._client.emit('world_particles', { particle: { type: 'fishing' }, amount: 6, x, y: 64, z });
  const destroy = (id = 20) => { delete bot.entities[id]; bot._client.emit('entity_destroy', { entityIds: [id] }); };
  return { ...inventory, spawn, bite, destroy };
}

function clean(bot: ReturnType<typeof fixture>['bot']): boolean {
  return ['spawn_entity', 'world_particles', 'entity_destroy'].every(event => bot._client.listenerCount(event) === 0);
}

test('no bobber ever appears: bounded result, no extra cast, no native fish promise', async t => {
  const { bot } = fixture();
  const result = await fishOnceVerified(bot, { timeoutMs: 5 });
  t.true(result.attempted); t.true(result.timedOut); t.false(result.castConfirmed);
  t.false(result.caughtItemConfirmed); t.false(result.cleanup.retractionIssued);
  t.true((bot.activateItem as sinon.SinonStub).calledOnce);
  t.false((bot.fish as sinon.SinonStub).called);
  t.true(clean(bot));
});

test('another player bobber and its bite cannot cause reeling', async t => {
  const { bot, spawn, bite } = fixture();
  (bot.activateItem as sinon.SinonStub).onFirstCall().callsFake(() => { spawn(20, 99); bite(); });
  const result = await fishOnceVerified(bot, { timeoutMs: 5 });
  t.false(result.castConfirmed); t.false(result.biteObserved); t.true(result.timedOut);
  t.true((bot.activateItem as sinon.SinonStub).calledOnce);
  t.true(clean(bot));
});

test('ownerless hook never gains ownership from timing or proximity', async t => {
  const { bot, bite } = fixture();
  (bot.activateItem as sinon.SinonStub).onFirstCall().callsFake(() => {
    bot._client.emit('spawn_entity', { entityId: 20, type: bot.registry.entitiesByName.fishing_bobber.id, x: 2, y: 64, z: 0 }); bite();
  });
  const result = await fishOnceVerified(bot, { timeoutMs: 5 });
  t.false(result.castConfirmed); t.false(result.reelIssued);
  t.true((bot.activateItem as sinon.SinonStub).calledOnce);
});

test('owned bite reels once and reports evidence without claiming a caught item', async t => {
  const { bot, spawn, bite, destroy } = fixture();
  (bot.activateItem as sinon.SinonStub).onFirstCall().callsFake(() => { spawn(); bite(); });
  (bot.activateItem as sinon.SinonStub).onSecondCall().callsFake(() => destroy());
  const result = await fishOnceVerified(bot, { timeoutMs: 20 });
  t.true(result.castConfirmed); t.true(result.biteObserved); t.true(result.reelIssued);
  t.true(result.hookRemovalConfirmed); t.false(result.caughtItemConfirmed); t.false(result.confirmed);
  t.is((bot.activateItem as sinon.SinonStub).callCount, 2);
  t.false(result.cleanup.retractionIssued); t.true(clean(bot));
});

test('timeout with a confirmed live hook retracts exactly once', async t => {
  const { bot, spawn } = fixture();
  (bot.activateItem as sinon.SinonStub).onFirstCall().callsFake(() => spawn());
  const result = await fishOnceVerified(bot, { timeoutMs: 5 });
  t.true(result.timedOut); t.true(result.cleanup.retractionIssued);
  t.is((bot.activateItem as sinon.SinonStub).callCount, 2); t.true(clean(bot));
});

test('cancellation without a bobber does not toggle a new cast', async t => {
  const { bot } = fixture();
  const controller = new AbortController();
  (bot.activateItem as sinon.SinonStub).callsFake(() => controller.abort());
  const result = await fishOnceVerified(bot, { timeoutMs: 500, signal: controller.signal });
  t.true(result.cancelled); t.false(result.cleanup.retractionIssued);
  t.true((bot.activateItem as sinon.SinonStub).calledOnce); t.true(clean(bot));
});

test('cancellation with owned hook retracts and removes all transient listeners', async t => {
  const { bot, spawn } = fixture();
  const controller = new AbortController();
  (bot.activateItem as sinon.SinonStub).onFirstCall().callsFake(() => { spawn(); controller.abort(); });
  const result = await fishOnceVerified(bot, { timeoutMs: 500, signal: controller.signal });
  t.true(result.cancelled); t.true(result.cleanup.retractionIssued);
  t.is((bot.activateItem as sinon.SinonStub).callCount, 2); t.true(clean(bot));
});

test('server hook removal stops waiting without any fresh cast', async t => {
  const { bot, spawn, destroy } = fixture();
  (bot.activateItem as sinon.SinonStub).onFirstCall().callsFake(() => { spawn(); destroy(); });
  const result = await fishOnceVerified(bot, { timeoutMs: 500 });
  t.true(result.hookRemovalConfirmed); t.false(result.cleanup.retractionIssued);
  t.true((bot.activateItem as sinon.SinonStub).calledOnce); t.true(clean(bot));
});

test('a changed hand never activates another item during cancellation cleanup', async t => {
  const { bot, spawn } = fixture();
  const controller = new AbortController();
  (bot.activateItem as sinon.SinonStub).onFirstCall().callsFake(() => { spawn(); bot.quickBarSlot = 1; controller.abort(); });
  const result = await fishOnceVerified(bot, { timeoutMs: 500, signal: controller.signal });
  t.false(result.cleanup.retractionIssued); t.regex(result.cleanup.note!, /Rod is no longer held/);
  t.true((bot.activateItem as sinon.SinonStub).calledOnce); t.true(clean(bot));
});

test('nearby competing bobber makes an otherwise matching bite ambiguous', async t => {
  const { bot, spawn, bite } = fixture();
  (bot.activateItem as sinon.SinonStub).onFirstCall().callsFake(() => { spawn(); spawn(30, 99, new Vec3(2.2, 64, 0)); bite(); });
  const result = await fishOnceVerified(bot, { timeoutMs: 5 });
  t.false(result.biteObserved); t.true(result.timedOut);
  t.true(result.cleanup.retractionIssued); t.true(clean(bot));
});

test('session end never sends a cleanup packet', async t => {
  const { bot, spawn } = fixture();
  (bot.activateItem as sinon.SinonStub).onFirstCall().callsFake(() => { spawn(); bot.emit('end', 'closed'); });
  const result = await fishOnceVerified(bot, { timeoutMs: 500 });
  t.false(result.cleanup.releaseIssued); t.false(result.cleanup.retractionIssued);
  t.true((bot.activateItem as sinon.SinonStub).calledOnce); t.true(clean(bot));
});

test('invalid duration and pre-aborted signal issue no cast', async t => {
  const { bot } = fixture();
  await t.throwsAsync(fishOnceVerified(bot, { timeoutMs: 60001 }), { message: /between 1 and 60000/ });
  const controller = new AbortController(); controller.abort();
  await t.throwsAsync(fishOnceVerified(bot, { signal: controller.signal }));
  t.false((bot.activateItem as sinon.SinonStub).called); t.true(clean(bot));
});

test('wrong held item rejects without any native call', async t => {
  const { bot, authority } = fixture();
  authority.getFrame(0).slots[36] = null;
  await t.throwsAsync(fishOnceVerified(bot), { message: /fishing_rod/ });
  t.false((bot.activateItem as sinon.SinonStub).called); t.true(clean(bot));
});
