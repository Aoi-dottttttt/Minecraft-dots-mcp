import test from 'ava';
import { createRequire } from 'node:module';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { consumeOnceVerified, snapshotConsumption, confirmConsumption } from '../src/verified-consumption.js';
import { ToolFactory } from '../src/tool-factory.js';

const require = createRequire(import.meta.url);
function fixture(name = 'cooked_porkchop', count = 1, slot = 44) {
  const s = inventoryFixture([{ name, count, slot }]);
  const Item = require('prismarine-item')(s.bot.registry);
  const effects: string[] = [];
  s.bot.quickBarSlot = 8;
  s.bot.food = 12;
  s.bot.deactivateItem = () => { effects.push('release'); s.bot.usingHeldItem = false; };
  const native = async () => {
    effects.push('use'); s.bot.usingHeldItem = true;
    await new Promise<void>(resolve => s.bot._client.once('entity_status', () => resolve()));
  };
  const status = () => s.bot._client.emit('entity_status', { entityId: 3, entityStatus: 9 });
  const update = (newCount: number, newName = name, target = slot) => {
    s.bot._client.emit('set_slot', { windowId: 0, stateId: 2, slot: target,
      item: Item.toNotch(newCount ? new Item(s.bot.registry.itemsByName[newName].id, newCount) : null) });
  };
  return { ...s, effects, native, status, update };
}

test('food-first native completion retains the action lane until authoritative inventory removal and release', async t => {
  const s = fixture();
  const factory = new ToolFactory({} as McpServer, {} as ConstructorParameters<typeof ToolFactory>[1]);
  const first = factory.runInActionLane(() => consumeOnceVerified(s.bot, s.native, { timeoutMs: 500 }));
  const second = factory.runInActionLane(async () => { s.effects.push('next-action'); });
  await nextTurn();
  s.bot.food = 20; s.bot.emit('health'); s.status();
  await nextTurn();
  t.deepEqual(s.effects, ['use']);
  t.is(s.authority.getFrame(0).slots[44]?.count, 1);
  s.update(0);
  t.deepEqual(await first, { confirmed: true, item: 'cooked_porkchop', consumed: 1 });
  await second;
  t.deepEqual(s.effects, ['use', 'release', 'next-action']);
  t.is(s.authority.listenerCount('change'), 0);
});

test('inventory-first native completion confirms one consumed item without hunger changes', async t => {
  const s = fixture('bread', 3);
  const pending = consumeOnceVerified(s.bot, s.native, { timeoutMs: 500 });
  s.update(2); s.status();
  t.true((await pending).confirmed);
  t.is(s.bot.food, 12); t.is(s.authority.fence, null);
  t.deepEqual(s.effects, ['use', 'release']);
  t.false(s.bot.usingHeldItem);
});

test('native finish and full hunger without removal time out, release use and fence future mutations', async t => {
  const s = fixture();
  const pending = consumeOnceVerified(s.bot, s.native, { timeoutMs: 20 });
  s.bot.food = 20; s.status();
  await t.throwsAsync(pending, { message: /timed out.*inventory removal/ });
  t.deepEqual(s.effects, ['use', 'release']);
  t.is(s.authority.listenerCount('change'), 0);
  t.truthy(s.authority.fence);
  s.update(0); // A late packet cannot silently clear the uncertainty or retry use.
  await t.throwsAsync(consumeOnceVerified(s.bot, s.native), { message: /safety lock/ });
  t.deepEqual(s.effects, ['use', 'release']);
});

test('fresh unrelated and unchanged selected-slot packets do not count as consumption', async t => {
  const s = fixture('bread', 2);
  const pending = consumeOnceVerified(s.bot, s.native, { timeoutMs: 20 });
  s.status(); s.update(1, 'dirt', 9); s.update(2);
  await t.throwsAsync(pending, { message: /timed out/ });
  t.truthy(s.authority.fence); t.deepEqual(s.effects, ['use', 'release']);
});

test('moving the selected stack to another slot is not a consumed item', async t => {
  const s = fixture();
  const pending = consumeOnceVerified(s.bot, s.native, { timeoutMs: 20 });
  s.status(); s.update(1, 'cooked_porkchop', 9); s.update(0);
  await t.throwsAsync(pending, { message: /timed out/ });
  t.truthy(s.authority.fence); t.deepEqual(s.effects, ['use', 'release']);
});

test('ordinary stew remainder in the selected slot confirms consumption', async t => {
  const s = fixture('mushroom_stew');
  const pending = consumeOnceVerified(s.bot, s.native, { timeoutMs: 500 });
  s.status(); s.update(1, 'bowl');
  t.true((await pending).confirmed);
  t.is(s.authority.getFrame(0).slots[44]?.name, 'bowl');
  t.deepEqual(s.effects, ['use', 'release']);
});

test('an unrelated item replacing food never receives consumption confirmation', async t => {
  const s = fixture();
  const pending = consumeOnceVerified(s.bot, s.native, { timeoutMs: 20 });
  s.status(); s.update(1, 'dirt');
  await t.throwsAsync(pending, { message: /timed out/ });
  t.truthy(s.authority.fence);
});

test('more than one removed item is uncertain rather than confirmation of a single use', async t => {
  const s = fixture('bread', 3);
  const pending = consumeOnceVerified(s.bot, s.native, { timeoutMs: 20 });
  s.status(); s.update(1);
  await t.throwsAsync(pending, { message: /timed out/ });
  t.truthy(s.authority.fence); t.deepEqual(s.effects, ['use', 'release']);
});

test('native rejection releases once, fences uncertainty and does not retry', async t => {
  const s = fixture();
  await t.throwsAsync(consumeOnceVerified(s.bot, async () => { s.effects.push('use'); throw new Error('native timeout'); }), { message: 'native timeout' });
  t.deepEqual(s.effects, ['use', 'release']); t.truthy(s.authority.fence);
  t.is(s.authority.listenerCount('change'), 0);
});

test('invalid consumption deadlines are rejected before native use', async t => {
  const s = fixture();
  for (const timeoutMs of [0, -1, 10001, NaN, Infinity, 1.5]) {
    await t.throwsAsync(consumeOnceVerified(s.bot, s.native, { timeoutMs }), { message: /timeoutMs/ });
  }
  t.deepEqual(s.effects, []); t.is(s.authority.fence, null);
});

test('aborting confirmation removes listeners, releases and preserves the uncertainty fence', async t => {
  const s = fixture(); const controller = new AbortController();
  const pending = consumeOnceVerified(s.bot, s.native, { timeoutMs: 500, signal: controller.signal });
  s.status(); await nextTurn(); controller.abort();
  await t.throwsAsync(pending, { name: 'AbortError' });
  t.is(s.authority.listenerCount('change'), 0);
  t.deepEqual(s.effects, ['use', 'release']); t.truthy(s.authority.fence);
});

test('item-use cleanup failure cannot produce a confirmed result', async t => {
  const s = fixture();
  s.bot.deactivateItem = () => { s.effects.push('release'); throw new Error('release failed'); };
  const pending = consumeOnceVerified(s.bot, s.native, { timeoutMs: 500 });
  s.status(); s.update(0);
  await t.throwsAsync(pending, { message: 'release failed' });
  t.truthy(s.authority.fence); t.deepEqual(s.effects, ['use', 'release']);
});

test('auto-eat barrier ignores food-first status after equipping and supports an offhand remainder', async t => {
  const s = fixture('beetroot_soup', 1, 9);
  const before = snapshotConsumption(s.bot);
  const selected = before.slots[9]!;
  s.update(1, 'beetroot_soup', 45); s.update(0, 'beetroot_soup', 9);
  s.bot.food = 20; s.status();
  let done = false;
  const pending = confirmConsumption(s.bot, before, selected, { offHand: true, timeoutMs: 500 }).then(() => { done = true; });
  await nextTurn(); t.false(done);
  s.update(1, 'bowl', 45);
  await pending; t.true(done); t.is(s.authority.listenerCount('change'), 0);
});
