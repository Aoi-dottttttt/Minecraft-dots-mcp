import test from 'ava';
import { createRequire } from 'node:module';
import { clickWindowVerified, furnaceActionVerified, readWindowVerified, transferWindowVerified } from '../src/verified-window-actions.js';
import { windowFixture } from './helpers/window-fixture.js';

const require = createRequire(import.meta.url);
type Race = 'second' | 'first' | 'between' | 'reported' | 'none';
type Fault = 'reject' | 'missing_cursor' | 'wrong_cursor_count' | 'wrong_cursor_item' | 'wrong_cursor_components' | 'wrong_fuel' | 'wrong_fuel_components' | 'unrelated_loss' | 'source_change' | 'invalid_duration' | 'invalid_progress' | 'invalid_burn' | 'stale_progress' | 'missing_properties' | 'stale_properties' | 'wrong_window_properties' | 'repeat_loss' | 'window' | 'death' | 'cancel';

/** Server-side slots and remote slot cache are distinct. Broadcast sends changed
 * slots, then cursor (with its own state ID), then furnace properties. In the
 * race a consumed coal + deposited coal leaves the remote target unchanged.
 * This deliberately does not send a full inventory after every click.
 */
function fixture({ type = 'minecraft:furnace', fuel = 'coal', race = 'second', fault, propertiesFirst = false, fullFirstFuel = false }: { type?: string; fuel?: string; race?: Race; fault?: Fault; propertiesFirst?: boolean; fullFirstFuel?: boolean } = {}) {
  const s = windowFixture(type, 3, [{ name: fuel, count: 5, slot: 10 }, { name: 'diamond', count: 2, slot: 11 }]);
  const Item = require('prismarine-item')(s.bot.registry);
  type Stack = typeof s.slots[number];
  const raw = (item: Stack) => Item.toNotch(item);
  const copy = (item: Stack): Stack => Item.fromNotch(raw(item));
  const same = (a: Stack, b: Stack) => JSON.stringify(raw(a)) === JSON.stringify(raw(b));
  const controller = new AbortController();
  readWindowVerified(s.bot); // Install the property observer before opening.
  s.slots[0] = s.item(type === 'minecraft:smoker' ? 'potato' : type === 'minecraft:blast_furnace' ? 'iron_ore' : 'cobblestone', 32);
  s.open();
  let state = s.authority.getFrame(7).stateId;
  let remoteSlots = s.slots.map(copy);
  let remoteCursor: Stack = null;
  let fuelClicks = 0;
  const duration = type === 'minecraft:furnace' ? 1600 : 800;
  const properties = [0, 0, fault === 'stale_progress' ? 1 : 0, type === 'minecraft:furnace' ? 200 : 100];
  const remoteProperties = [...properties];
  const property = (key: number, value: number, windowId = 7) => s.bot._client.emit('craft_progress_bar', { windowId, property: key, value });
  if (fault !== 'missing_properties') properties.forEach((value, key) => property(key, value));
  if (fault === 'stale_properties') {
    properties[0] = duration - 10; properties[1] = duration;
    properties.forEach((value, key) => { property(key, value); remoteProperties[key] = value; });
  }
  const sendProperties = () => {
    if (fault === 'missing_properties' || fault === 'stale_properties') return;
    properties.forEach((value, key) => {
      if (remoteProperties[key] !== value) {
        property(key, value, fault === 'wrong_window_properties' ? 8 : 7);
        remoteProperties[key] = value;
      }
    });
  };
  const burn = () => {
    const stack = s.slots[1];
    if (stack) s.slots[1] = stack.count === 1 ? null : { ...stack, count: stack.count - 1 };
    properties[0] = fault === 'invalid_burn' ? duration + 1 : duration; properties[1] = fault === 'invalid_duration' ? duration + 1 : duration;
    properties[2] = fault === 'invalid_progress' ? properties[3] + 1 : 1;
  };
  const cursorPacket = () => {
    const cursor = s.getCursor();
    if (!same(cursor, remoteCursor) && !(fault === 'missing_cursor' && fuelClicks === 2)) {
      s.bot._client.emit('set_slot', { windowId: 255, slot: -1, stateId: ++state, item: raw(cursor) });
      remoteCursor = copy(cursor);
    }
  };
  const broadcast = (full = false) => {
    if (full) {
      s.bot._client.emit('window_items', { windowId: 7, stateId: ++state, items: s.slots.map(raw), carriedItem: raw(s.getCursor()) });
      remoteSlots = s.slots.map(copy); remoteCursor = copy(s.getCursor());
    } else {
      s.slots.forEach((item, slot) => {
        if (!same(item, remoteSlots[slot])) {
          s.bot._client.emit('set_slot', { windowId: 7, slot, stateId: ++state, item: raw(item) });
          remoteSlots[slot] = copy(item);
        }
      });
      if (propertiesFirst) sendProperties();
      cursorPacket();
    }
    if (fuelClicks === 2) {
      if (fault === 'window') s.bot._client.emit('open_window', { windowId: 7 });
      if (fault === 'death') s.bot.emit('death');
      if (fault === 'cancel') controller.abort();
    }
    sendProperties();
  };
  s.bot._client.write = ((name: string, value: unknown) => {
    const packet = value as { slot: number; mouseButton: number; stateId: number };
    s.writes.push({ name, packet });
    if (name !== 'window_click') return;
    // A separate event-loop turn makes the confirmation wait subscribe first.
    setImmediate(() => {
      const slot = packet.slot;
      if (slot === 1) fuelClicks++;
      if (slot === 1 && fuelClicks === 2 && race === 'second') burn();
      const old = s.slots[slot];
      const cursor = s.getCursor();
      if (slot === 1 && fuelClicks === 2 && fault === 'reject') {
        // Burning is real, but the deposit is rejected: cursor must prove it.
      } else if (!cursor) {
        if (old) {
          const take = packet.mouseButton === 0 ? old.count : Math.ceil(old.count / 2);
          s.setCursor({ ...copy(old)!, count: take });
          s.slots[slot] = old.count === take ? null : { ...copy(old)!, count: old.count - take };
        }
      } else if (!old || old.type === cursor.type) {
        const count = Math.min(packet.mouseButton === 0 ? cursor.count : 1, cursor.stackSize - (old?.count ?? 0));
        s.slots[slot] = { ...copy(cursor)!, count: (old?.count ?? 0) + count };
        s.setCursor(cursor.count === count ? null : { ...copy(cursor)!, count: cursor.count - count });
      } else { s.slots[slot] = cursor; s.setCursor(old); }
      if (slot === 1 && fuelClicks === 1 && race === 'first') burn();
      if (slot === 1 && fuelClicks === 2) {
        if (fault === 'wrong_cursor_count') s.setCursor(s.item(fuel, 2));
        if (fault === 'wrong_cursor_item') s.setCursor(s.item('charcoal', 3));
        if (fault === 'wrong_cursor_components') Object.assign(s.getCursor()!, { components: [{ type: 'custom_name', data: { type: 'string', value: 'changed' } }] });
        if (fault === 'wrong_fuel') s.slots[1] = s.item('charcoal', 1);
        if (fault === 'wrong_fuel_components') Object.assign(s.slots[1]!, { components: [{ type: 'custom_name', data: { type: 'string', value: 'changed' } }] });
        if (fault === 'unrelated_loss') s.slots[5] = null;
        if (fault === 'source_change') s.slots[4] = s.item(fuel, 1);
      }
      if (slot === 1 && fuelClicks === 3 && fault === 'repeat_loss') {
        const stack = s.slots[1]!;
        s.slots[1] = stack.count === 1 ? null : { ...stack, count: stack.count - 1 };
      }
      broadcast(packet.stateId !== state || (fullFirstFuel && slot === 1 && fuelClicks === 1));
      if (slot === 1 && fuelClicks === 1 && (race === 'between' || race === 'reported')) {
        burn();
        if (race === 'reported') broadcast();
        else sendProperties();
      }
    });
  }) as typeof s.bot._client.write;
  const run = (count = 4) => furnaceActionVerified(s.bot, { slot: 'fuel', op: 'put', itemName: fuel, count, timeoutMs: 1000, signal: controller.signal });
  return { ...s, run, property, broadcast, controller, fuelClicks: () => fuelClicks };
}

for (const type of ['minecraft:furnace', 'minecraft:smoker', 'minecraft:blast_furnace']) {
  for (const fuel of ['coal', 'charcoal']) {
    test(`${type} ${fuel}: suppressed unchanged target is proved by cursor then burn properties`, async t => {
      const s = fixture({ type, fuel });
      const result = await s.run();
      t.is(result.transferred, 4); t.is(result.window.slots[1].item?.count, 3);
      t.is(result.window.slots[4].item?.count, 1); t.is(result.window.cursor, null); t.is(s.authority.fence, null);
      t.is(s.fuelClicks(), 4);
    });
  }
}

for (const variant of [{ propertiesFirst: true }, { fullFirstFuel: true }, { race: 'first' as const }, { race: 'between' as const }, { race: 'reported' as const }]) {
  test(`fuel burn packet ordering ${JSON.stringify(variant)} preserves exact delivered count`, async t => {
    const s = fixture(variant); const result = await s.run();
    t.is(result.transferred, 4); t.is(result.window.slots[1].item?.count, 3); t.is(s.authority.cursor, null); t.is(s.authority.fence, null);
  });
}

for (const fault of ['reject', 'missing_cursor', 'wrong_cursor_count', 'wrong_cursor_item', 'wrong_cursor_components', 'wrong_fuel', 'wrong_fuel_components', 'unrelated_loss', 'source_change', 'invalid_duration', 'invalid_progress', 'invalid_burn', 'stale_progress', 'missing_properties', 'stale_properties', 'wrong_window_properties', 'repeat_loss', 'window', 'death', 'cancel'] as const) {
  test(`fuel race fails closed for ${fault}`, async t => {
    const s = fixture({ fault });
    await t.throwsAsync(s.run()); t.truthy(s.authority.fence);
    t.is(s.fuelClicks(), fault === 'repeat_loss' ? 3 : 2);
    t.is(s.authority.listenerCount('change'), 0);
    const count = s.writes.length; await new Promise(resolve => setImmediate(resolve)); t.is(s.writes.length, count);
  });
}

test('one coal immediately consumed can confirm an unchanged empty target', async t => {
  const s = fixture({ race: 'first' }); const result = await s.run(1);
  t.is(result.transferred, 1); t.is(result.window.slots[1].item, null);
  t.is(result.window.slots[4].item?.count, 4); t.is(result.window.cursor, null); t.is(s.authority.fence, null);
});

test('a bulk deposit with one coal consumed requires a fresh reduced fuel slot', async t => {
  const s = fixture({ race: 'first' }); const result = await s.run(5);
  t.is(result.transferred, 5); t.is(result.window.slots[1].item?.count, 4);
  t.is(result.window.slots[4].item, null); t.is(result.window.cursor, null); t.is(s.authority.fence, null);
});

test('an independently reported fuel decrease consumes the burn budget before the next missing coal', async t => {
  const s = fixture({ race: 'reported', fault: 'repeat_loss' });
  await t.throwsAsync(s.run()); t.truthy(s.authority.fence); t.is(s.fuelClicks(), 3);
});

test('a burn credit cannot cross separate actions', async t => {
  const s = fixture(); await s.run();
  s.setCursor(s.item('coal', 1));
  s.bot._client.emit('set_slot', { windowId: 255, slot: -1, stateId: 90, item: s.authority.raw({ ...s.authority.getFrame(7).slots[1]!, count: 1 }) });
  s.bot._client.write = (() => s.bot._client.emit('set_slot', { windowId: 255, slot: -1, stateId: 91, item: s.authority.raw(null) })) as typeof s.bot._client.write;
  await t.throwsAsync(clickWindowVerified(s.bot, { slot: 1, timeoutMs: 50 })); t.truthy(s.authority.fence);
});

test('unknown fuel never receives a furnace consumption exception', async t => {
  const s = fixture({ fuel: 'stone' });
  await t.throwsAsync(s.run()); t.truthy(s.authority.fence); t.is(s.fuelClicks(), 2);
});

test('source pickup still requires its own fresh slot confirmation', async t => {
  const s = fixture();
  s.bot._client.write = (() => s.bot._client.emit('set_slot', { windowId: 255, slot: -1, stateId: 90, item: s.authority.raw(s.authority.getFrame(7).slots[4]) })) as typeof s.bot._client.write;
  await t.throwsAsync(s.run()); t.truthy(s.authority.fence); t.is(s.fuelClicks(), 0);
});

test('ordinary containers cannot use furnace properties to excuse an unchanged target', async t => {
  const s = windowFixture('minecraft:generic_9x1', 9); s.open(); readWindowVerified(s.bot);
  await clickWindowVerified(s.bot, { slot: 9 });
  s.bot._client.write = (() => {
    s.bot._client.emit('craft_progress_bar', { windowId: 7, property: 0, value: 1600 });
    s.bot._client.emit('set_slot', { windowId: 255, slot: -1, stateId: 90, item: s.authority.raw(null) });
  }) as typeof s.bot._client.write;
  await t.throwsAsync(clickWindowVerified(s.bot, { slot: 1, timeoutMs: 50 })); t.truthy(s.authority.fence);
});

test('pre-cancelled furnace transfer submits nothing', async t => {
  const s = fixture(); s.controller.abort();
  await t.throwsAsync(transferWindowVerified(s.bot, { sourceSlots: [4], destinationSlots: [1], count: 4, signal: s.controller.signal }));
  t.is(s.writes.length, 0); t.is(s.authority.fence, null);
});
