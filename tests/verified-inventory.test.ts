import test from 'ava';
import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';
import { equipVerified } from '../src/verified-inventory.js';
import { inventoryFixture } from './helpers/inventory-fixture.js';

const require = createRequire(import.meta.url);
const { createSerializer, createDeserializer } = require('minecraft-protocol');
const encoder = createSerializer({ state: 'play', isServer: true, version: '1.21.1' });
const decoder = createDeserializer({ state: 'play', isServer: false, version: '1.21.1' });
type Fixture = ReturnType<typeof inventoryFixture>;
type Click = { windowId: number; stateId: number; slot: number; mouseButton: number; mode: number; changedSlots: unknown[] };
type ItemsPacket = { windowId: number; stateId: number; items: unknown[]; carriedItem: unknown };

function matchingStacks(sourceCount = 21, targetCount = 21, target = 39): Fixture {
  const s = inventoryFixture([{ name: 'cobblestone', count: sourceCount, slot: 13 }, { name: 'cobblestone', count: targetCount, slot: target }]);
  s.bot.quickBarSlot = 3;
  return s;
}

/** Exercise actual protocol-767 slot/cursor corrections, including unsigned 255. */
function fragmented(s: Fixture, omit?: 'slot' | 'cursor'): void {
  const emit = s.bot._client.emit.bind(s.bot._client);
  let previous = s.slots.map(item => s.authority.raw(item));
  s.bot._client.emit = ((name: string, ...args: unknown[]) => {
    if (name !== 'window_items') return emit(name, ...args);
    const packet = args[0] as ItemsPacket;
    const wire = (slot: number, item: unknown, windowId = 0) => {
      const bytes = encoder.createPacketBuffer({ name: 'set_slot', params: { windowId, stateId: packet.stateId, slot, item } });
      const decoded = decoder.parsePacketBuffer(bytes).data;
      emit(decoded.name, decoded.params);
    };
    if (omit !== 'slot') packet.items.forEach((item, slot) => {
      if (JSON.stringify(previous[slot]) !== JSON.stringify(item)) wire(slot, item);
    });
    if (omit !== 'cursor') wire(-1, packet.carriedItem, 255);
    previous = packet.items;
    return true;
  }) as Bot['_client']['emit'];
}

for (const [sourceCount, targetCount] of [[21, 21], [4, 7], [50, 40], [64, 21], [21, 64], [64, 64]]) {
  for (const destination of ['hand', 'off-hand'] as const) {
    test(`exact equipment keeps matching ${sourceCount}/${targetCount} stacks separate in ${destination}`, async t => {
      const target = destination === 'hand' ? 39 : 45;
      const s = matchingStacks(sourceCount, targetCount, target);
      fragmented(s);
      await equipVerified(s.bot, 13, destination, 100, { exactSource: true });
      t.is(s.authority.getFrame(0).slots[target]?.count, sourceCount);
      t.is(s.authority.getFrame(0).slots[13]?.count, targetCount);
      t.is(s.authority.getFrame(0).slots[9], null);
      t.deepEqual((s.writes as Click[]).map(click => click.slot), [target, 9, 13, target, 9, 13]);
      t.true((s.writes as Click[]).every(click => click.mode === 0 && click.mouseButton === 0 && click.changedSlots.length === 0));
      t.is(s.authority.cursor, null);
      t.is(s.authority.fence, null);
      t.is(s.authority.getFrame(0).slots.reduce((sum, item) => sum + (item?.name === 'cobblestone' ? item.count : 0), 0), sourceCount + targetCount);
      t.is(s.authority.listenerCount('change'), 0);
      t.is(s.bot._client.listenerCount('open_horse_window'), 0);
      t.is(s.bot.listenerCount('windowClose'), 0);
    });
  }
}

for (const destination of ['hand', 'off-hand'] as const) {
  test(`exact ${destination} rejects a full inventory before sending clicks or fencing`, async t => {
    const target = destination === 'hand' ? 39 : 45;
    const items = Array.from({ length: 36 }, (_, index) => ({ name: 'stone', count: 1, slot: 9 + index }));
    items.push({ name: 'cobblestone', count: 21, slot: 13 }, { name: 'cobblestone', count: 21, slot: target });
    const s = inventoryFixture(items);
    const before = s.authority.getFrame(0).slots.map(item => s.authority.raw(item));
    s.bot.quickBarSlot = 3;
    await t.throwsAsync(equipVerified(s.bot, 13, destination, 20, { exactSource: true }), { message: /one empty inventory storage slot.*No click was sent/ });
    t.is(s.writes.length, 0);
    t.deepEqual(s.authority.getFrame(0).slots.map(item => s.authority.raw(item)), before);
    t.is(s.authority.fence, null);
    t.is(s.authority.cursor, null);
    t.is(s.bot.quickBarSlot, 3);
    // Empty crafting and armor slots must not be borrowed as scratch storage.
    t.true(s.authority.getFrame(0).slots.slice(0, 9).every(item => item === null));
  });
}

test('ordinary matching equip and an explicit hotbar source remain zero-click selections', async t => {
  const s = matchingStacks();
  await equipVerified(s.bot, 13, 'hand', 20);
  t.is(s.writes.length, 0);
  t.is(s.bot.quickBarSlot, 3);
  const hotbar = inventoryFixture([{ name: 'cobblestone', count: 21, slot: 36 }, { name: 'cobblestone', count: 21, slot: 40 }]);
  await equipVerified(hotbar.bot, 40, 'hand', 20, { exactSource: true });
  t.is(hotbar.bot.quickBarSlot, 4);
  t.is(hotbar.writes.length, 0);
});

test('distinct item components still use the ordinary three-click swap', async t => {
  const s = inventoryFixture([{ name: 'iron_pickaxe', count: 1, slot: 13 }, { name: 'iron_pickaxe', count: 1, slot: 39 }]);
  Object.assign(s.slots[13], { components: [{ type: 'damage', data: 7 }] });
  Object.assign(s.slots[39], { components: [{ type: 'damage', data: 31 }] });
  s.sync(); s.bot.quickBarSlot = 3;
  const source = s.authority.identity(s.authority.getFrame(0).slots[13]!);
  const target = s.authority.identity(s.authority.getFrame(0).slots[39]!);
  await equipVerified(s.bot, 13, 'hand', 20, { exactSource: true });
  t.is(s.writes.length, 3);
  t.is(s.authority.identity(s.authority.getFrame(0).slots[39]!), source);
  t.is(s.authority.identity(s.authority.getFrame(0).slots[13]!), target);
  t.is(s.authority.cursor, null);
  t.is(s.authority.fence, null);
});

for (let failAt = 1; failAt <= 6; failAt++) {
  test(`rejected staging click ${failAt} fences once and never sends a subsequent click`, async t => {
    const s = matchingStacks();
    const write = s.bot._client.write.bind(s.bot._client);
    const attempts: Click[] = [];
    s.bot._client.write = ((name: string, raw: unknown) => {
      attempts.push(raw as Click);
      if (attempts.length === failAt) s.sync(); // Rejection snapshot, no move.
      else write(name, raw);
    }) as Bot['_client']['write'];
    await t.throwsAsync(equipVerified(s.bot, 13, 'hand', 10, { exactSource: true }), { message: /timed out/ });
    t.is(attempts.length, failAt);
    t.truthy(s.authority.fence);
    const fence = s.authority.fence;
    s.sync();
    await t.throwsAsync(equipVerified(s.bot, 13, 'hand', 10, { exactSource: true }), { message: /safety lock/ });
    t.is(attempts.length, failAt);
    t.is(s.authority.fence, fence);
    t.is(s.authority.listenerCount('change'), 0);
    t.is(s.bot._client.listenerCount('open_horse_window'), 0);
  });
}

for (const omit of ['slot', 'cursor'] as const) {
  test(`fresh ${omit} evidence is required before continuing an exact transfer`, async t => {
    const s = matchingStacks();
    fragmented(s, omit);
    await t.throwsAsync(equipVerified(s.bot, 13, 'hand', 10, { exactSource: true }), { message: /timed out/ });
    t.is(s.writes.length, 1);
    t.truthy(s.authority.fence);
    t.is(s.authority.listenerCount('change'), 0);
  });
}

test('unrelated valid pickups during staging remain conserved', async t => {
  const s = matchingStacks();
  const Item = require('prismarine-item')(s.bot.registry);
  s.slots[20] = new Item(s.bot.registry.itemsByName.birch_door.id, 1); s.sync();
  const write = s.bot._client.write.bind(s.bot._client);
  s.bot._client.write = ((name: string, raw: unknown) => {
    write(name, raw);
    if (s.writes.length === 2) {
      s.slots[20].count++;
      s.slots[21] = new Item(s.bot.registry.itemsByName.ladder.id, 1);
      s.sync();
    }
  }) as Bot['_client']['write'];
  await equipVerified(s.bot, 13, 'hand', 30, { exactSource: true });
  t.is(s.authority.getFrame(0).slots[20]?.count, 2);
  t.is(s.authority.getFrame(0).slots[21]?.name, 'ladder');
  t.is(s.writes.length, 6);
  t.is(s.authority.fence, null);
});

for (const [label, change, at] of [
  ['source disappears', (s: Fixture) => { s.slots[13] = null; }, 1],
  ['source stack shrinks', (s: Fixture) => { s.slots[13].count--; }, 2],
  ['scratch becomes occupied', (s: Fixture) => { s.slots[9] = s.slots[13]; }, 1],
  ['staged target changes', (s: Fixture) => { s.slots[9].count++; }, 2],
  ['new target stack changes', (s: Fixture) => { s.slots[39].count++; }, 4],
  ['scratch refills at completion', (s: Fixture) => { s.slots[9] = s.slots[13]; }, 6]
] as const) {
  test(`exact transfer stops when ${label}`, async t => {
    const s = matchingStacks();
    const write = s.bot._client.write.bind(s.bot._client);
    s.bot._client.write = ((name: string, raw: unknown) => {
      write(name, raw);
      if (s.writes.length === at) { change(s); s.sync(); }
    }) as Bot['_client']['write'];
    await t.throwsAsync(equipVerified(s.bot, 13, 'hand', 10, { exactSource: true }), { message: /conservation|timed out/ });
    t.is(s.writes.length, at);
    t.truthy(s.authority.fence);
  });
}

for (const label of ['unrelated loss', 'window transition', 'respawn', 'disconnect']) {
  test(`exact transfer never clears its safety fence after ${label}`, async t => {
    const s = matchingStacks();
    const Item = require('prismarine-item')(s.bot.registry);
    s.slots[20] = new Item(s.bot.registry.itemsByName.ladder.id, 2); s.sync();
    const write = s.bot._client.write.bind(s.bot._client);
    s.bot._client.write = ((name: string, raw: unknown) => {
      write(name, raw);
      if (s.writes.length !== 2) return;
      if (label === 'unrelated loss') { s.slots[20].count--; s.sync(); }
      else if (label === 'window transition') {
        s.bot._client.emit('open_window', { windowId: 7 });
        s.bot._client.emit('close_window', { windowId: 7 });
      } else if (label === 'respawn') { s.bot._client.emit('respawn', {}); s.sync(); }
      else s.bot.emit('end', 'fixture disconnect');
    }) as Bot['_client']['write'];
    await t.throwsAsync(equipVerified(s.bot, 13, 'hand', 20, { exactSource: true }));
    t.is(s.writes.length, label === 'unrelated loss' ? 6 : 2);
    t.truthy(s.authority.fence);
    const fence = s.authority.fence;
    s.authority.armRespawnRecovery(); s.bot._client.emit('respawn', {}); s.sync();
    t.is(s.authority.fence, fence);
    t.is(s.authority.listenerCount('change'), 0);
    t.is(s.bot._client.listenerCount('open_horse_window'), 0);
  });
}

test('merge-aware fixture models Vanilla partial filling and full-stack no-ops', t => {
  const s = matchingStacks(50, 40);
  const click = (slot: number) => s.bot._client.write('window_click', { windowId: 0, stateId: s.authority.getFrame(0).stateId, slot, mouseButton: 0, mode: 0, changedSlots: [], cursorItem: s.authority.raw(s.authority.cursor) });
  click(13); click(39);
  t.is(s.authority.getFrame(0).slots[39]?.count, 64);
  t.is(s.authority.cursor?.count, 26);
  click(39);
  t.is(s.authority.getFrame(0).slots[39]?.count, 64);
  t.is(s.authority.cursor?.count, 26);
});

for (const slot of [5, 6, 7, 8]) {
  test(`unrelated armor slot ${slot} accepts only server-confirmed monotonic durability during exact swap`, async t => {
    const names = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];
    const s = inventoryFixture([{ name: 'iron_axe', count: 1, slot: 17 }, { name: 'stone', count: 3, slot: 37 }, { name: names[slot - 5], count: 1, slot }]);
    fragmented(s); s.bot.quickBarSlot = 1;
    const write = s.bot._client.write.bind(s.bot._client);
    s.bot._client.write = ((name: string, packet: unknown) => {
      s.slots[slot].components = [{ type: 'damage', data: s.writes.length + 1 }];
      write(name, packet);
    }) as Bot['_client']['write'];
    await equipVerified(s.bot, 17, 'hand', 30, { exactSource: true });
    t.is(s.writes.length, 3); t.is(s.authority.cursor, null); t.is(s.authority.fence, null);
    t.is(s.authority.getFrame(0).slots[37]?.name, 'iron_axe');
  });
}

for (const change of ['repair', 'replacement', 'count', 'component', 'break', 'over_max', 'negative', 'fractional', 'duplicate_damage', 'rollback_then_restore']) {
  test(`armor wear exception still fences ${change} during an unrelated transfer`, async t => {
    const s = inventoryFixture([{ name: 'iron_axe', count: 1, slot: 17 }, { name: 'stone', count: 3, slot: 37 }, { name: 'iron_helmet', count: 1, slot: 5 }]);
    const Item = require('prismarine-item')(s.bot.registry);
    s.slots[5].components = [{ type: 'damage', data: 10 }]; s.sync(); s.bot.quickBarSlot = 1;
    const write = s.bot._client.write.bind(s.bot._client);
    s.bot._client.write = ((name: string, packet: unknown) => {
      write(name, packet);
      if (s.writes.length !== 1) return;
      if (change === 'replacement') s.slots[5] = new Item(s.bot.registry.itemsByName.diamond_helmet.id, 1);
      else if (change === 'count') s.slots[5].count = 2;
      else if (change === 'break') s.slots[5] = null;
      else s.slots[5].components = change === 'component' ? [{ type: 'damage', data: 11 }, { type: 'repair_cost', data: 1 }]
        : change === 'duplicate_damage' ? [{ type: 'damage', data: 11 }, { type: 'damage', data: 12 }]
        : [{ type: 'damage', data: change === 'repair' || change === 'rollback_then_restore' ? 9 : change === 'negative' ? -1 : change === 'fractional' ? 10.5 : 165 }];
      s.sync();
      if (change === 'rollback_then_restore') { s.slots[5].components = [{ type: 'damage', data: 11 }]; s.sync(); }
    }) as Bot['_client']['write'];
    await t.throwsAsync(equipVerified(s.bot, 17, 'hand', 30, { exactSource: true }), { message: /conservation/ });
    t.truthy(s.authority.fence); t.is(s.authority.listenerCount('change'), 0);
  });
}

test('armor transfer target itself never receives the unrelated durability exception', async t => {
  const s = inventoryFixture([{ name: 'iron_helmet', count: 1, slot: 17 }]);
  const write = s.bot._client.write.bind(s.bot._client);
  s.bot._client.write = ((name: string, packet: unknown) => {
    write(name, packet);
    if (s.writes.length === 2) { s.slots[5].components = [{ type: 'damage', data: 1 }]; s.sync(); }
  }) as Bot['_client']['write'];
  await t.throwsAsync(equipVerified(s.bot, 17, 'head', 20), { message: /conservation|timed out/ });
  t.truthy(s.authority.fence);
});
