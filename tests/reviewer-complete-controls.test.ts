import test from 'ava';
import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { windowFixture } from './helpers/window-fixture.js';
import { openVillagerVerified, tradeWithVillagerVerified, enchantItemVerified, anvilCombineVerified } from '../src/verified-workstation-actions.js';
const require = createRequire(import.meta.url);
const position = { x: 0, y: 0, z: 0, timeoutMs: 500 };
function workstation(type: string, size: number, items: Array<{ name: string; count: number; slot: number }>) {
  const s = windowFixture(type, size, items);
  Object.assign(s.bot, { experience: { level: 30 }, entities: { 8: { id: 8, name: 'villager', type: 'mob', position: new Vec3(1, 0, 0) } } });
  const Item = require('prismarine-item')(s.bot.registry);
  const serialize = (item: unknown): unknown => Item.toNotch(item);
  const property = (key: number, value: number): void => { s.bot._client.emit('craft_progress_bar', { windowId: 7, property: key, value }); };
  return { ...s, serialize, property };
}
function merchant() {
  const s = workstation('minecraft:merchant', 3, [{ name: 'emerald', count: 9, slot: 9 }]);
  const trade = { inputItem1: s.serialize(s.item('emerald', 2)), outputItem: s.serialize(s.item('bread', 3)), maximumNbTradeUses: 10, nbTradeUses: 0, tradeDisabled: false, demand: 0, specialPrice: 0, priceMultiplier: 0 };
  s.bot.activateEntity = async () => { s.open(); s.bot._client.emit('trade_list', { windowId: 7, trades: [trade] }); };
  const write = s.bot._client.write.bind(s.bot._client);
  let consume = true;
  s.bot._client.write = ((name: string, packet: unknown) => {
    if (name === 'select_trade') {
      const source = s.slots.slice(3).findIndex(item => item?.name === 'emerald');
      if (source >= 0) { const stack = s.slots[source + 3]!; s.slots[source + 3] = null; s.slots[0] = s.item('emerald', (s.slots[0]?.count ?? 0) + stack.count); }
      s.slots[2] = s.item('bread', 3); s.sync();
    }
    write(name, packet);
  }) as Bot['_client']['write'];
  s.settings.onClick = slot => {
    if (slot === 2 && consume) { const count = s.slots[0]!.count - 2; s.slots[0] = count ? s.item('emerald', count) : null; }
  };
  return { ...s, disableConsumption: () => { consume = false; } };
}

test.serial('review: villager offers come from fresh server packets and wait listeners are removed', async t => {
  const s = merchant(); const before = s.bot._client.listenerCount('trade_list');
  const result = await openVillagerVerified(s.bot, 8, { timeoutMs: 500 });
  t.true(result.confirmed as boolean); t.is((result.trades as unknown[]).length, 1);
  t.is(s.bot._client.listenerCount('trade_list'), before); t.is(s.authority.listenerCount('change'), 0);
});

test.serial('review: missing merchant offers time out without a native hanging promise', async t => {
  const s = merchant(); s.bot.activateEntity = async () => { s.open(); };
  await t.throwsAsync(openVillagerVerified(s.bot, 8, { timeoutMs: 15 }), { message: /timed out/ });
  t.is(s.bot._client.listenerCount('trade_list'), 0); t.is(s.authority.listenerCount('change'), 0);
});

test.serial('review: merchant offer wait aborts promptly and disposes all added listeners', async t => {
  const s = merchant(); const controller = new AbortController();
  s.bot.activateEntity = async () => { s.open(); setTimeout(() => controller.abort(), 2); };
  await t.throwsAsync(openVillagerVerified(s.bot, 8, { timeoutMs: 500, signal: controller.signal }));
  t.is(s.bot._client.listenerCount('trade_list'), 0); t.is(s.authority.listenerCount('change'), 0);
});

test.serial('review: exact repeated trades verify both consumed payment and received output', async t => {
  const s = merchant(); await openVillagerVerified(s.bot, 8, { timeoutMs: 500 });
  const result = await tradeWithVillagerVerified(s.bot, { tradeIndex: 0, times: 2, timeoutMs: 500 });
  t.true(result.confirmed as boolean); t.is(result.totalReceived, 6);
  t.is(s.authority.count(s.bot.registry.itemsByName.emerald.id), 5); t.is(s.authority.count(s.bot.registry.itemsByName.bread.id), 6);
  t.is(s.authority.cursor, null); t.is(s.authority.fence, null);
});

test.serial('review: product without exact payment consumption is not confirmed and fences', async t => {
  const s = merchant(); s.disableConsumption(); await openVillagerVerified(s.bot, 8, { timeoutMs: 500 });
  await t.throwsAsync(tradeWithVillagerVerified(s.bot, { tradeIndex: 0, timeoutMs: 15 }), { message: /timed out/ });
  t.truthy(s.authority.fence); t.is(s.authority.listenerCount('change'), 0);
});

test.serial('review: stale merchant session and invalid repeat count reject without packets', async t => {
  const s = merchant(); await openVillagerVerified(s.bot, 8, { timeoutMs: 500 });
  await t.throwsAsync(tradeWithVillagerVerified(s.bot, { tradeIndex: 0, times: 65 }), { message: /1..64/ });
  s.bot.currentWindow = null;
  await t.throwsAsync(tradeWithVillagerVerified(s.bot, { tradeIndex: 0 }), { message: /fresh server offers/ });
  t.is(s.writes.length, 0);
});

function enchanting() {
  const s = workstation('minecraft:enchantment', 2, [{ name: 'book', count: 3, slot: 9 }, { name: 'lapis_lazuli', count: 5, slot: 10 }]);
  s.settings.onClick = () => { for (let i = 0; i < 3; i++) s.property(i, s.slots[0] ? i + 1 : 0); };
  const write = s.bot._client.write.bind(s.bot._client);
  s.bot._client.write = ((name: string, packet: unknown) => {
    if (name === 'enchant_item') {
      const output = s.item('enchanted_book', 1);
      Object.assign(output, { components: [{ type: 'stored_enchantments', data: { enchantments: [{ id: 0, level: 1 }], showTooltip: true } }] });
      s.slots[0] = output; s.slots[1] = s.item('lapis_lazuli', 4); s.bot.experience.level = 29; s.sync(); s.bot.emit('experience');
    }
    write(name, packet);
  }) as Bot['_client']['write'];
  return s;
}

test.serial('review: enchant preview remaps pre-open player slots and returns exact inputs', async t => {
  const s = enchanting();
  const result = await enchantItemVerified(s.bot, { ...position, item: 'book' });
  t.true(result.confirmed as boolean); t.false(result.applied as boolean);
  t.is(s.writes[0].packet.slot, 2); // Player slot 9 maps to menu slot 2.
  t.is(s.authority.count(s.bot.registry.itemsByName.book.id), 3); t.is(s.authority.count(s.bot.registry.itemsByName.lapis_lazuli.id), 5);
  t.is(s.bot.currentWindow, null); t.is(s.authority.fence, null);
});

test.serial('review: book enchant requires changed server components, lapis and experience consumption', async t => {
  const s = enchanting();
  const result = await enchantItemVerified(s.bot, { ...position, item: 'book', choice: 0 });
  t.true(result.confirmed as boolean); t.is(result.lapisConsumed, 1);
  t.is(s.authority.count(s.bot.registry.itemsByName.book.id), 2); t.is(s.authority.count(s.bot.registry.itemsByName.enchanted_book.id), 1);
  t.is(s.authority.count(s.bot.registry.itemsByName.lapis_lazuli.id), 4); t.is(s.bot.experience.level, 29);
  t.is(s.bot.currentWindow, null); t.is(s.authority.fence, null);
});

test.serial('review: missing enchant offers time out, retain inputs visibly and remove wait listeners', async t => {
  const s = enchanting(); s.settings.onClick = () => {};
  const before = s.bot._client.listenerCount('craft_progress_bar');
  await t.throwsAsync(enchantItemVerified(s.bot, { ...position, timeoutMs: 200, item: 'book' }), { message: /timed out/ });
  t.truthy(s.authority.fence); t.is(s.authority.cursor, null); t.truthy(s.bot.currentWindow);
  t.is(s.bot._client.listenerCount('craft_progress_bar'), before + 1); // Persistent shared window tracker only.
  t.is(s.authority.listenerCount('change'), 0);
});

function anvil() {
  const s = workstation('minecraft:anvil', 3, [{ name: 'iron_sword', count: 1, slot: 9 }, { name: 'iron_ingot', count: 3, slot: 10 }]);
  const write = s.bot._client.write.bind(s.bot._client);
  let charge = true;
  const output = (name?: string): void => {
    s.slots[2] = s.item('iron_sword', 1);
    Object.assign(s.slots[2]!, { components: name === undefined ? [{ type: 'damage', data: 0 }] : [{ type: 'custom_name', data: { type: 'string', value: name } }] });
    s.property(0, 2); s.sync();
  };
  s.bot._client.write = ((name: string, packet: unknown) => {
    if (name === 'name_item') output((packet as { name: string }).name);
    write(name, packet);
  }) as Bot['_client']['write'];
  s.settings.onClick = slot => {
    if (slot === 1 && s.slots[0] && s.slots[1]) output();
    if (slot === 2) {
      s.slots[0] = null;
      if (s.slots[1]) s.slots[1] = s.item('iron_ingot', s.slots[1]!.count - 1);
      if (charge) { s.bot.experience.level -= 2; s.bot.emit('experience'); }
    }
  };
  return { ...s, disableCharge: () => { charge = false; } };
}

test.serial('review: anvil rename verifies requested name, inputs, returned output and exact level cost', async t => {
  const s = anvil();
  const result = await anvilCombineVerified(s.bot, { ...position, itemOneSlot: 9, name: 'Trusted sword' });
  t.true(result.confirmed as boolean); t.is(result.renamedTo, 'Trusted sword'); t.is(result.experienceConsumed, 2);
  t.is(s.bot.experience.level, 28); t.is(s.authority.count(s.bot.registry.itemsByName.iron_sword.id), 1);
  t.is(s.bot.currentWindow, null); t.is(s.authority.fence, null);
});

test.serial('review: anvil repair returns unused materials with exact component accounting', async t => {
  const s = anvil();
  const result = await anvilCombineVerified(s.bot, { ...position, itemOneSlot: 9, itemTwoSlot: 10 });
  t.true(result.confirmed as boolean); t.is(result.secondItemConsumed, 1);
  t.is(s.authority.count(s.bot.registry.itemsByName.iron_ingot.id), 2); t.is(s.authority.cursor, null); t.is(s.authority.fence, null);
});

test.serial('review: anvil result without server experience acknowledgement remains unconfirmed', async t => {
  const s = anvil(); s.disableCharge();
  await t.throwsAsync(anvilCombineVerified(s.bot, { ...position, timeoutMs: 15, itemOneSlot: 9, name: 'Trusted sword' }), { message: /timed out/ });
  t.truthy(s.authority.fence); t.is(s.authority.listenerCount('change'), 0); t.is(s.bot.listenerCount('experience'), 0);
});


test.serial('review: insufficient enchanting experience returns known inputs without a safety fence', async t => {
  const s = enchanting(); s.bot.experience.level = 0;
  await t.throwsAsync(enchantItemVerified(s.bot, { ...position, item: 'book', choice: 0 }), { message: /inputs were returned/ });
  t.is(s.authority.count(s.bot.registry.itemsByName.book.id), 3); t.is(s.authority.count(s.bot.registry.itemsByName.lapis_lazuli.id), 5);
  t.is(s.authority.fence, null); t.is(s.bot.currentWindow, null);
});

test.serial('review: insufficient anvil experience returns known inputs without a safety fence', async t => {
  const s = anvil(); s.bot.experience.level = 1;
  await t.throwsAsync(anvilCombineVerified(s.bot, { ...position, itemOneSlot: 9, name: 'Trusted sword' }), { message: /inputs were returned/ });
  t.is(s.authority.count(s.bot.registry.itemsByName.iron_sword.id), 1); t.is(s.authority.count(s.bot.registry.itemsByName.iron_ingot.id), 3);
  t.is(s.authority.fence, null); t.is(s.bot.currentWindow, null);
});
