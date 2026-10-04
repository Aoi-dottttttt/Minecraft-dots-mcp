// Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
import test from 'ava';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import { ToolFactory } from '../src/tool-factory.js';
import { registerCraftingTools } from '../src/tools/crafting-tools.js';
import { installInventoryAuthority } from '../src/inventory-authority.js';
import { craftVerified, type VerifiedRecipe } from '../src/verified-crafting.js';
import { Vec3 } from 'vec3';

const require = createRequire(import.meta.url);
const registry = require('prismarine-registry')('1.21.1');
const Item = require('prismarine-item')(registry);
const logId: number = registry.itemsByName.birch_log.id;
const plankId: number = registry.itemsByName.birch_planks.id;
const stack = (type: number, count: number) => new Item(type, count);
const recipe: VerifiedRecipe = { result: { id: plankId, count: 4 }, inShape: [[{ id: logId }]] };

type FakeItem = { type: number; count: number } | null;
type Click = { slot: number; stateId: number; mouseButton: number; cursorItem: unknown };
function server(options: { output?: boolean; rejectPickup?: boolean; rejectDeposit?: boolean; interruptAfterPickup?: boolean; throwAfterPickup?: boolean; initialState?: number; fragments?: boolean; loseExtraInput?: boolean; disconnect?: boolean } = {}) {
  const client = new EventEmitter() as EventEmitter & { write: (name: string, packet: Click) => void };
  const emitter = new EventEmitter();
  const bot = Object.assign(emitter, {
    _client: client, registry, supportFeature: (name: string) => name === 'stateIdUsed',
    inventory: { slots: Array(46).fill(null), selectedItem: null, updateSlot: () => undefined },
    currentWindow: null as null | { id: number },
  }) as unknown as Bot;
  const authority = installInventoryAuthority(bot);
  const slots: FakeItem[] = Array(46).fill(null);
  slots[9] = stack(logId, 2);
  let cursor: FakeItem = null;
  let state = options.initialState ?? 1;
  const writes: Click[] = [];
  const sync = () => client.emit('window_items', { windowId: 0, stateId: state, items: slots.map(i => Item.toNotch(i)), carriedItem: Item.toNotch(cursor) });
  sync();
  client.write = (name, packet) => {
    if (name !== 'window_click') throw new Error(`Unexpected write ${name}`);
    if (packet.stateId !== state) throw new Error(`Stale stateId ${packet.stateId}, current ${state}`);
    writes.push(packet);
    if (options.disconnect) { bot.emit('end', 'Simulated disconnect'); return; }
    const previous = slots.map(i => i ? { type: i.type, count: i.count } : null);
    const cursorBefore = cursor ? { type: cursor.type, count: cursor.count } : null;
    if (options.throwAfterPickup && writes.length === 2) throw new Error('Simulated synchronous transport failure');
    const slot = packet.slot;
    if (options.rejectPickup && writes.length === 1) { sync(); return; }
    if (options.rejectDeposit && cursor?.type === plankId && slot >= 9) { sync(); return; }
    if (slot === 0) {
      cursor = slots[0]; slots[0] = null;
      slots[1] = null;
      if (options.loseExtraInput) slots[9] = null;
    } else if (cursor === null) {
      cursor = slots[slot]; slots[slot] = null;
    } else if (packet.mouseButton === 1) {
      slots[slot] = stack(cursor.type, (slots[slot]?.count ?? 0) + 1);
      cursor = cursor.count > 1 ? stack(cursor.type, cursor.count - 1) : null;
    } else {
      slots[slot] = stack(cursor.type, (slots[slot]?.count ?? 0) + cursor.count);
      cursor = null;
    }
    if (slot >= 1 && slot <= 4) slots[0] = options.output !== false && slots[1]?.type === logId ? stack(plankId, 4) : null;
    state = (state + 1) % 32768;
    if (options.fragments) {
      for (let i = 0; i < slots.length; i++) {
        if (JSON.stringify(previous[i]) !== JSON.stringify(slots[i] ? { type: slots[i]!.type, count: slots[i]!.count } : null)) {
          client.emit('set_slot', { windowId: 0, stateId: state, slot: i, item: Item.toNotch(slots[i]) });
        }
      }
      if (JSON.stringify(cursorBefore) !== JSON.stringify(cursor ? { type: cursor.type, count: cursor.count } : null)) {
        client.emit('set_slot', { windowId: -1, stateId: state, slot: -1, item: Item.toNotch(cursor) });
      }
    } else sync();
    if (options.interruptAfterPickup && writes.length === 1) bot.currentWindow = { id: 7 } as Bot['currentWindow'];
  };
  return { bot, authority, slots, writes, sync };
}

test('review: authoritative inventory acceptance and conservation succeed through state-ID wrap', async t => {
  const s = server({ initialState: 32767 });
  const result = await craftVerified(s.bot, recipe, undefined, 25);
  t.is(result.outputCount, 4);
  t.is(s.authority.count(plankId), 4);
  t.is(s.authority.count(logId), 1);
  t.is(s.authority.cursor, null);
  t.is(s.authority.fence, null);
  t.is(s.writes[1].stateId, 0);
});

function tableFixture(visible = true) {
  const s = server();
  const table = { name: 'crafting_table', position: new Vec3(1, 0, 0) } as NonNullable<Parameters<Bot['craft']>[2]>;
  let activations = 0;
  Object.assign(s.bot, {
    entity: { position: new Vec3(0, 0, 0) }, blockAt: () => table, canSeeBlock: () => visible, getControlState: () => false,
    activateBlock: async () => { activations++; }
  });
  return { ...s, table, activations: () => activations };
}

test('review: occluded crafting table fails before activation without a safety fence', async t => {
  const s = tableFixture(false);
  await t.throwsAsync(craftVerified(s.bot, recipe, s.table, 10), { message: /not visible/ });
  t.is(s.activations(), 0); t.is(s.writes.length, 0); t.is(s.authority.fence, null);
  // A later safe action remains available; this is not an uncertain inventory write.
  await craftVerified(s.bot, recipe, undefined, 25);
  t.is(s.authority.count(plankId), 4);
});

test('review: unloaded or replaced crafting table fails before activation', async t => {
  const s = tableFixture(); s.bot.blockAt = () => null;
  await t.throwsAsync(craftVerified(s.bot, recipe, s.table, 10), { message: /no longer loaded/ });
  t.is(s.activations(), 0); t.is(s.writes.length, 0); t.is(s.authority.fence, null);
  s.bot.blockAt = () => ({ name: 'stone', position: s.table.position } as typeof s.table);
  await t.throwsAsync(craftVerified(s.bot, recipe, s.table, 10), { message: /no longer loaded/ });
  t.is(s.activations(), 0); t.is(s.writes.length, 0); t.is(s.authority.fence, null);
});

test('review: distant crafting table fails before activation', async t => {
  const s = tableFixture(); s.table.position = new Vec3(10, 0, 0);
  await t.throwsAsync(craftVerified(s.bot, recipe, s.table, 10), { message: /outside safe interaction reach/ });
  t.is(s.activations(), 0); t.is(s.writes.length, 0); t.is(s.authority.fence, null);
});

test('review: sneaking table interaction is rejected before any packet', async t => {
  const s = tableFixture(); s.bot.getControlState = () => true;
  await t.throwsAsync(craftVerified(s.bot, recipe, s.table, 10), { message: /Stop sneaking/ });
  t.is(s.activations(), 0); t.is(s.writes.length, 0); t.is(s.authority.fence, null);
});

test('review: submitted table opening timeout stays fenced against late-window races', async t => {
  const s = tableFixture();
  await t.throwsAsync(craftVerified(s.bot, recipe, s.table, 10), { message: /open crafting table/ });
  t.is(s.activations(), 1); t.is(s.writes.length, 0); t.regex(s.authority.fence!, /late window/);
  s.sync();
  await t.throwsAsync(craftVerified(s.bot, recipe, undefined, 10), { message: /safety lock/ });
  t.is(s.writes.length, 0);
});

test('review: slow activation settles before timed-out craft releases its lane', async t => {
  const s = tableFixture(); let settled = false;
  s.bot.activateBlock = async () => { await new Promise(resolve => setTimeout(resolve, 30)); settled = true; };
  await t.throwsAsync(craftVerified(s.bot, recipe, s.table, 5), { message: /timed out/ });
  t.true(settled); t.is(s.writes.length, 0); t.truthy(s.authority.fence);
  t.is(s.authority.listenerCount('change'), 0);
});

test('review: missing server output never causes a result click and safely recovers inputs', async t => {
  const s = server({ output: false });
  await t.throwsAsync(craftVerified(s.bot, recipe, undefined, 10), { message: /server-generated recipe output/ });
  t.false(s.writes.some(p => p.slot === 0));
  t.is(s.authority.count(plankId), 0);
  t.is(s.authority.count(logId), 2);
  t.is(s.authority.cursor, null);
  t.is(s.authority.fence, null);
});

test('review: output slot alone is insufficient without real inventory destination acceptance', async t => {
  const s = server({ rejectDeposit: true });
  await t.throwsAsync(craftVerified(s.bot, recipe, undefined, 10), { message: /safety lock/ });
  t.is(s.authority.count(plankId), 0);
  t.is(s.authority.cursor?.type, plankId);
  t.truthy(s.authority.fence);
  const writeCount = s.writes.length;
  await t.throwsAsync(craftVerified(s.bot, recipe, undefined, 10), { message: /safety lock/ });
  t.is(s.writes.length, writeCount);
});

test('review: rejected source pickup fences and never fabricates output', async t => {
  const s = server({ rejectPickup: true });
  await t.throwsAsync(craftVerified(s.bot, recipe, undefined, 10));
  t.is(s.writes.length, 1);
  t.is(s.authority.count(logId), 2);
  t.is(s.authority.count(plankId), 0);
  t.truthy(s.authority.fence);
});

test('review: window switch after pickup must fence the retained cursor', async t => {
  const s = server({ interruptAfterPickup: true });
  await t.throwsAsync(craftVerified(s.bot, recipe, undefined, 10));
  t.is(s.authority.cursor?.type, logId);
  t.truthy(s.authority.fence);
});

test('review: synchronous transport failure after pickup must not leave an unfenced cursor', async t => {
  const s = server({ throwAfterPickup: true });
  await t.throwsAsync(craftVerified(s.bot, recipe, undefined, 10));
  t.true(s.authority.fence !== null || (s.authority.cursor === null && s.authority.count(logId) === 2));
});

test('review: subsequent full sync does not erase a safety fence', t => {
  const s = server();
  s.authority.block('Uncertain prior click');
  s.sync();
  t.throws(() => s.authority.assertMutationReady(), { message: /Uncertain prior click/ });
});

test('review: cursor and special inventory corrections are server-authoritative', t => {
  const s = server();
  s.bot._client.emit('set_slot', { windowId: -1, slot: -1, stateId: 99, item: Item.toNotch(stack(plankId, 4)) });
  t.is(s.authority.cursor?.type, plankId);
  s.bot._client.emit('set_slot', { windowId: -1, slot: -1, stateId: 100, item: Item.toNotch(null) });
  t.is(s.authority.cursor, null);
  s.bot._client.emit('set_slot', { windowId: -2, slot: 10, stateId: 101, item: Item.toNotch(stack(plankId, 4)) });
  t.is(s.authority.count(plankId), 4);
});


test('review: fragmented output-before-input server updates still confirm a real recipe', async t => {
  const s = server({ fragments: true });
  const result = await craftVerified(s.bot, recipe, undefined, 10);
  t.is(result.outputCount, 4);
  t.is(s.authority.count(plankId), 4);
  t.is(s.authority.count(logId), 1);
  t.is(s.authority.fence, null);
});

test('review: extra material loss fails conservation and locks subsequent mutations', async t => {
  const s = server({ loseExtraInput: true });
  await t.throwsAsync(craftVerified(s.bot, recipe, undefined, 10), { message: /conservation/ });
  t.truthy(s.authority.fence);
  t.is(s.authority.count(plankId), 4);
  t.is(s.authority.count(logId), 0);
});

test('review: disconnect during click terminates confirmation and fences the outcome', async t => {
  const s = server({ disconnect: true });
  await t.throwsAsync(craftVerified(s.bot, recipe, undefined, 10), { message: /session ended/ });
  t.is(s.writes.length, 1);
  t.truthy(s.authority.fence);
});

test('review: full inventory is rejected before clicks without dropping anything', async t => {
  const s = server();
  for (let i = 10; i < 45; i++) s.slots[i] = stack(registry.itemsByName.stone.id, 64);
  s.sync();
  await t.throwsAsync(craftVerified(s.bot, recipe, undefined, 10), { message: /empty inventory slot/ });
  t.is(s.writes.length, 0);
  t.is(s.authority.fence, null);
});

test('review: preexisting crafting output is never consumed as a new recipe', async t => {
  const s = server();
  s.slots[0] = stack(plankId, 4);
  s.sync();
  await t.throwsAsync(craftVerified(s.bot, recipe, undefined, 10), { message: /already occupied/ });
  t.is(s.writes.length, 0);
  t.is(s.authority.count(plankId), 0);
});

test('review: special -2 inventory indices map hotbar, armor and offhand correctly', t => {
  const s = server();
  for (const [inventoryIndex, windowSlot] of [[0, 36], [8, 44], [36, 8], [37, 7], [38, 6], [39, 5], [40, 45]]) {
    s.bot._client.emit('set_slot', { windowId: -2, slot: inventoryIndex, stateId: 15, item: Item.toNotch(stack(plankId, 4)) });
    t.is(s.authority.getFrame(0).slots[windowSlot]?.type, plankId);
  }
  t.is(s.authority.getFrame(0).slots[0], null);
});

test('review: new inventory and cursor correction packets use their protocol fields', t => {
  const s = server();
  s.bot._client.emit('set_player_inventory', { slotId: 1, contents: Item.toNotch(stack(plankId, 4)) });
  t.is(s.authority.getFrame(0).slots[37]?.type, plankId);
  s.bot._client.emit('set_cursor_item', { contents: Item.toNotch(stack(plankId, 4)) });
  t.is(s.authority.cursor?.type, plankId);
  s.bot._client.emit('set_cursor_item', { contents: Item.toNotch(null) });
  t.is(s.authority.cursor, null);
});

test('review: item identity distinguishes modern damage components', t => {
  const s = server();
  const a = stack(registry.itemsByName.wooden_pickaxe.id, 1);
  const b = stack(registry.itemsByName.wooden_pickaxe.id, 1);
  a.components = [{ type: 'damage', data: 1 }];
  b.components = [{ type: 'damage', data: 5 }];
  t.false(s.authority.same(a, b));
  t.true(s.authority.same(a, a));
});

test('review: malformed special inventory indices cannot overwrite valid slots', t => {
  const s = server();
  for (const slot of [-1, -36, 41, 45, 1.5]) {
    s.bot._client.emit('set_slot', { windowId: -2, slot, stateId: 15, item: Item.toNotch(stack(plankId, 4)) });
  }
  t.is(s.authority.count(plankId), 0);
  t.is(s.authority.getFrame(0).slots[45], null);
});


test('review: a partial batch reports only completed server-confirmed crafts', async t => {
  const s = server();
  Object.assign(s.bot, { version: '1.21.1', recipesFor: () => s.authority.count(logId) > 0 ? [recipe] : [] });
  type Response = { content: Array<{ text: string }>; isError?: boolean };
  const callbacks = new Map<string, (args: unknown) => Promise<Response>>();
  const mcp = { tool: (name: string, _description: unknown, _schema: unknown, executor: (args: unknown) => Promise<Response>) => callbacks.set(name, executor) };
  const connection = { checkConnectionAndReconnect: async () => ({ connected: true }) };
  const factory = new ToolFactory(mcp as unknown as McpServer, connection as unknown as BotConnection);
  registerCraftingTools(factory, () => s.bot);
  const result = await callbacks.get('craft-item')!({ outputItem: 'birch_planks', amount: 3 });
  t.true(result.isError);
  t.true(result.content[0].text.includes('Confirmed 2/3 craft(s), 8 output item(s)'));
  t.is(s.authority.count(plankId), 8);
  t.is(s.authority.count(logId), 0);
  t.is(s.authority.cursor, null);
  t.is(s.authority.fence, null);
});

test('review: explicit respawn clears only death lock and requires a fresh full snapshot', t => {
  const s = server(); s.bot.emit('death'); s.authority.armRespawnRecovery();
  t.throws(() => s.authority.assertMutationReady(), { message: /Player died/ });
  s.bot._client.emit('respawn', {});
  t.throws(() => s.authority.assertMutationReady(), { message: /authoritative inventory/ });
  s.sync(); t.notThrows(() => s.authority.assertMutationReady());
});
test('review: unexpected respawn never clears a death lock', t => {
  const s = server(); s.bot.emit('death'); s.bot._client.emit('respawn', {}); s.sync();
  t.throws(() => s.authority.assertMutationReady(), { message: /Player died/ });
});
test('review: uncertain prior action survives death and explicitly requested respawn', t => {
  const s = server(); s.authority.block('Prior uncertain transfer'); s.bot.emit('death'); s.authority.armRespawnRecovery();
  s.bot._client.emit('respawn', {}); s.sync();
  t.throws(() => s.authority.assertMutationReady(), { message: /Prior uncertain transfer/ });
});

test('review: local cursor mutation cannot alter the authoritative carried stack', t => {
  const s = server();
  s.bot._client.emit('set_slot', { windowId: -1, slot: -1, stateId: 15, item: Item.toNotch(stack(plankId, 4)) });
  s.bot.inventory.selectedItem!.count = 1;
  t.is(s.authority.cursor?.count, 4);
});

test('review: local inventory mutation cannot alter special-packet authoritative counts', t => {
  const s = server();
  s.bot.inventory.updateSlot = (slot, item) => { s.bot.inventory.slots[slot] = item; };
  s.bot._client.emit('set_slot', { windowId: -2, slot: 0, stateId: 15, item: Item.toNotch(stack(plankId, 4)) });
  s.bot.inventory.slots[36]!.count = 1;
  t.is(s.authority.getFrame(0).slots[36]?.count, 4);
});

test('review: decoded item component arrays never alias the raw packet or local cursor', t => {
  const s = server();
  const a = stack(registry.itemsByName.wooden_pickaxe.id, 1);
  a.components = [{ type: 'damage', data: 1 }];
  const raw = Item.toNotch(a);
  const slots = Array.from({ length: 46 }, () => Item.toNotch(null));
  slots[9] = raw;
  s.bot._client.emit('window_items', { windowId: 0, stateId: 15, items: slots, carriedItem: raw });
  raw.components[0].data = 99;
  const componentDamage = (value: unknown) => (value as Array<{ data: number }>)[0].data;
  t.is(componentDamage(s.authority.getFrame(0).slots[9]?.components), 1);
  t.is(componentDamage(s.authority.cursor?.components), 1);
  const local = s.bot.inventory.selectedItem as unknown as { components: Array<{ data: number }> };
  local.components[0].data = 88;
  t.is(componentDamage(s.authority.cursor?.components), 1);
});
