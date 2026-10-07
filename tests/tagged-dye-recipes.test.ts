import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import { ToolFactory } from '../src/tool-factory.js';
import { registerCraftingTools } from '../src/tools/crafting-tools.js';
import { installInventoryAuthority } from '../src/inventory-authority.js';

const require = createRequire(import.meta.url);
const registry = require('prismarine-registry')('1.21.1');
const Item = require('prismarine-item')(registry);
const Recipe = require('prismarine-recipe')(registry).Recipe;
const windows = require('prismarine-windows')(registry);
const colors = ['black', 'blue', 'brown', 'cyan', 'gray', 'green', 'light_blue', 'light_gray',
  'lime', 'magenta', 'orange', 'pink', 'purple', 'red', 'yellow', 'white'];
const id = (name: string): number => registry.itemsByName[name].id;
const item = (name: string, count = 1) => new Item(id(name), count);
type Stack = { type: number; count: number; name: string } | null;
type Click = { windowId: number; stateId: number; slot: number; mouseButton: number; mode: number };
type Response = { content: { text: string }[]; isError?: boolean };

// A neutral synthetic server, separate from Mineflayer's local window. It
// implements the 32 officially enumerated 1.21.1 wool/bed dye recipes only.
function fixture(contents: [string, number][], options: { signal?: AbortSignal; duringClick?: (click: Click, count: number) => void; reject?: boolean; extraLoss?: boolean } = {}) {
  const slots: Stack[] = Array(46).fill(null);
  contents.forEach(([name, count], i) => { slots[9 + i] = item(name, count); });
  let cursor: Stack = null;
  let state = 1;
  const inventory = windows.createWindow(0, 'minecraft:inventory', 'Offline dye fixture');
  const client = Object.assign(new EventEmitter(), { write: (_name: string, _packet: Click) => {} });
  const bot = Object.assign(new EventEmitter(), {
    _client: client, version: '1.21.1', registry, inventory, currentWindow: null,
    supportFeature: (name: string) => name === 'stateIdUsed',
    findBlock: sinon.stub().returns(null), craft: sinon.stub().resolves(),
    recipesAll: sinon.stub(), recipesFor: sinon.stub()
  });
  // Exercise the installed Recipe class and the locked recipesAll/recipesFor
  // selection semantics without loading a bot or opening any socket.
  bot.recipesAll.callsFake((resultId: number, metadata: number | null, table: unknown) =>
    Recipe.find(resultId, metadata).filter((r: { requiresTable: boolean }) => !r.requiresTable || table));
  bot.recipesFor.callsFake((resultId: number, metadata: number | null, _count: number, table: unknown) =>
    bot.recipesAll(resultId, metadata, table).filter((r: { delta: { id: number; metadata: number | null; count: number }[] }) =>
      r.delta.every(d => inventory.count(d.id, d.metadata) + d.count >= 0)));
  // Mineflayer normally mirrors these packets into its local window first.
  client.on('window_items', (packet: { items: unknown[] }) => {
    packet.items.forEach((raw, slot) => inventory.updateSlot(slot, Item.fromNotch(raw)));
  });
  const authority = installInventoryAuthority(bot as unknown as Bot);
  const sync = () => client.emit('window_items', {
    windowId: 0, stateId: state, items: slots.map(i => Item.toNotch(i)), carriedItem: Item.toNotch(cursor)
  });
  const writes: Click[] = [];
  const inputs: string[] = [];
  client.write = (name, click) => {
    if (name !== 'window_click' || click.windowId !== 0 || click.mode !== 0 || click.slot < 0 || click.slot >= 45) throw new Error('Unexpected synthetic click');
    if (click.stateId !== state) throw new Error('Stale synthetic state ID');
    writes.push(click);
    if (!options.reject) {
      if (click.slot === 0) {
        if (cursor || !slots[0]) throw new Error('Invalid output pickup');
        inputs.push(...slots.slice(1, 5).filter(Boolean).map(i => i!.name));
        cursor = slots[0];
        slots.fill(null, 0, 5);
        if (options.extraLoss) slots[11] = null;
      } else if (!cursor) {
        cursor = slots[click.slot]; slots[click.slot] = null;
      } else {
        const old = slots[click.slot];
        if (old && old.type !== cursor.type) throw new Error('Unexpected mismatched synthetic stack');
        const moved = click.mouseButton === 1 ? 1 : cursor.count;
        slots[click.slot] = item(cursor.name, (old?.count ?? 0) + moved);
        cursor = cursor.count > moved ? item(cursor.name, cursor.count - moved) : null;
      }
      if (click.slot >= 1 && click.slot <= 4) {
        const grid = slots.slice(1, 5).filter(Boolean);
        const dye = grid.find(i => i!.name.endsWith('_dye'));
        const source = grid.find(i => !i!.name.endsWith('_dye'));
        const target = dye?.name.slice(0, -4);
        const family = source?.name.endsWith('_wool') ? 'wool' : source?.name.endsWith('_bed') ? 'bed' : undefined;
        const sourceColor = family && source?.name.slice(0, -family.length - 1);
        const legal = grid.length === 2 && target && colors.includes(target) && sourceColor && colors.includes(sourceColor) && sourceColor !== target;
        slots[0] = legal ? item(`${target}_${family}`) : null;
      }
      state = (state + 1) % 32768;
    }
    sync();
    options.duringClick?.(click, writes.length);
  };
  sync();
  const handlers = new Map<string, (args: unknown) => Promise<Response>>();
  const server = { tool: (name: string, _description: unknown, _schema: unknown, executor: (args: unknown) => Promise<Response>) => handlers.set(name, executor) } as unknown as McpServer;
  const factory = new ToolFactory(server, {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection);
  registerCraftingTools(factory, () => bot as unknown as Bot, () => ({ signal: options.signal }));
  const invoke = (name: string, args: unknown) => handlers.get(name)!(args);
  return { bot, inventory, authority, slots, writes, inputs, sync, invoke,
    setCursor: (value: Stack) => { cursor = value; sync(); } };
}

for (const input of ['white_wool', 'light_gray_wool', 'brown_wool', 'white_bed']) {
  const output = input.endsWith('_bed') ? 'cyan_bed' : 'cyan_wool';
  test(`dye alternatives: ${input} agrees across reads and authoritative crafting`, async t => {
    const f = fixture([['cyan_dye', 8], [input, 1]]);
    t.regex((await f.invoke('can-craft', { itemName: output })).content[0].text, /Yes, can craft/);
    t.regex((await f.invoke('get-recipe', { itemName: output })).content[0].text, new RegExp(`${input} x1`));
    t.regex((await f.invoke('list-recipes', { outputItem: output })).content[0].text, new RegExp(`${input} x1`));
    t.is(f.writes.length, 0);
    const result = await f.invoke('craft-item', { outputItem: output });
    t.falsy(result.isError);
    t.regex(result.content[0].text, new RegExp(`Server-confirmed 1 craft\\(s\\): 1 ${output}`));
    t.true(f.bot.craft.notCalled);
    t.is(f.authority.count(id(input)), 0);
    t.is(f.authority.count(id('cyan_dye')), 7);
    t.is(f.authority.count(id(output)), 1);
    t.is(f.authority.cursor, null);
    t.true(f.authority.getFrame(0).slots.slice(0, 5).every(i => i === null));
    t.is(f.authority.fence, null);
  });
}

test('dye alternatives: all 480 official different-color wool/bed pairs conserve exact server counts', async t => {
  let checked = 0;
  for (const family of ['wool', 'bed']) for (const target of colors) for (const source of colors.filter(color => color !== target)) {
    const input = `${source}_${family}`;
    const output = `${target}_${family}`;
    const dye = `${target}_dye`;
    const f = fixture([[input, 1], [dye, 1]]);
    t.regex((await f.invoke('can-craft', { itemName: output })).content[0].text, /Yes, can craft/, `${input} -> ${output}`);
    t.falsy((await f.invoke('craft-item', { outputItem: output })).isError, `${input} -> ${output}`);
    t.deepEqual(f.authority.items().map(i => [i.name, i.count]), [[output, 1]]);
    t.deepEqual(f.inputs.sort(), [input, dye].sort());
    t.true(f.bot.craft.notCalled);
    t.is(f.authority.cursor, null);
    t.is(f.authority.fence, null);
    checked++;
  }
  t.is(checked, 480);
});

test('dye alternatives: all 32 same-color inputs remain illegal in reads and execution', async t => {
  for (const family of ['wool', 'bed']) for (const color of colors) {
    const output = `${color}_${family}`;
    const f = fixture([[output, 1], [`${color}_dye`, 64]]);
    t.notRegex((await f.invoke('can-craft', { itemName: output })).content[0].text, /Yes, can craft/);
    t.regex((await f.invoke('list-recipes', { outputItem: output })).content[0].text, /No craftable recipes/);
    t.true((await f.invoke('craft-item', { outputItem: output })).isError);
    t.is(f.writes.length, 0);
    t.true(f.bot.craft.notCalled);
  }
});

test('dye alternatives: missing dye, wrong dye/family and carpets do not substitute', async t => {
  for (const contents of [
    [['white_wool', 6]], [['white_wool', 6], ['blue_dye', 8]],
    [['white_bed', 1], ['cyan_dye', 8]], [['white_carpet', 6], ['cyan_dye', 8]], [['cyan_dye', 8]]
  ] as [string, number][][]) {
    const f = fixture(contents);
    t.notRegex((await f.invoke('can-craft', { itemName: 'cyan_wool' })).content[0].text, /Yes, can craft/);
    t.true((await f.invoke('craft-item', { outputItem: 'cyan_wool' })).isError);
    t.is(f.writes.length, 0);
  }
});

test('dye alternatives: batch reselects actual mixed split stacks and never recycles its output', async t => {
  const f = fixture([['white_wool', 3], ['white_wool', 1], ['light_gray_wool', 1], ['brown_wool', 1], ['cyan_dye', 7]]);
  const result = await f.invoke('craft-item', { outputItem: 'cyan_wool', amount: 7 });
  t.true(result.isError);
  t.regex(result.content[0].text, /Confirmed 6\/7 craft\(s\), 6 output/);
  t.is(f.authority.count(id('cyan_wool')), 6);
  t.is(f.authority.count(id('cyan_dye')), 1);
  t.deepEqual(f.inputs.filter(name => name !== 'cyan_dye').sort(),
    ['white_wool', 'white_wool', 'white_wool', 'white_wool', 'light_gray_wool', 'brown_wool'].sort());
  const writes = f.writes.length;
  t.true((await f.invoke('craft-item', { outputItem: 'cyan_wool' })).isError);
  t.is(f.writes.length, writes);
  t.is(f.authority.fence, null);
});

test('dye alternatives: capacity, cursor, grid, window and existing fence reject before clicks', async t => {
  for (const failure of ['full', 'cursor', 'grid', 'window', 'fence']) {
    const f = fixture([['white_wool', 4], ['cyan_dye', 7]]);
    if (failure === 'full') for (let slot = 11; slot < 45; slot++) f.slots[slot] = item('stone', 64);
    if (failure === 'grid') f.slots[1] = item('white_wool', 2);
    if (failure === 'window') Object.assign(f.bot, { currentWindow: { id: 2 } });
    if (failure === 'fence') f.authority.block('Prior uncertain synthetic transfer');
    f.sync();
    if (failure === 'cursor') f.setCursor(item('white_wool', 2));
    const before = JSON.stringify(f.slots);
    const result = await f.invoke('craft-item', { outputItem: 'cyan_wool' });
    t.true(result.isError, failure);
    t.is(f.writes.length, 0, failure);
    t.is(JSON.stringify(f.slots), before);
    t.true(f.bot.craft.notCalled);
  }
});

test('dye alternatives: malformed templates, unsupported versions and missing resolver fail closed', async t => {
  for (const failure of ['plain', 'delta', 'result', 'remainder', 'shape', 'metadata', 'table', 'same-color', 'version', 'absent']) {
    const f = fixture([['white_wool', 4], ['cyan_dye', 7]]);
    f.bot.recipesFor.returns([]);
    const template = new Recipe({ ingredients: [id('cyan_dye'), id('black_wool')], result: { id: id('cyan_wool'), count: 1 } });
    if (failure === 'delta') template.delta[0].count = -2;
    if (failure === 'result') template.result.count = 2;
    if (failure === 'remainder') template.outShape = [];
    if (failure === 'shape') template.inShape = [];
    if (failure === 'metadata') template.ingredients[1].metadata = 1;
    if (failure === 'table') template.requiresTable = true;
    if (failure === 'same-color') template.ingredients[1].id = id('cyan_wool');
    if (failure === 'version') f.bot.version = '1.21.4';
    if (failure === 'absent') Object.assign(f.bot, { recipesAll: undefined });
    else f.bot.recipesAll.returns([failure === 'plain' ? { ...template } : template]);
    t.true((await f.invoke('craft-item', { outputItem: 'cyan_wool' })).isError, failure);
    t.is(f.writes.length, 0, failure);
  }
});

test('dye alternatives: original templates/registry are immutable and exact names beat substring siblings', async t => {
  const f = fixture([['white_wool', 2], ['light_gray_wool', 1], ['gray_dye', 2], ['light_gray_dye', 1]]);
  const beforeRecipes = JSON.stringify(registry.recipes);
  const templates = Recipe.find(id('gray_wool'), null);
  const beforeTemplates = JSON.stringify(templates);
  f.bot.recipesAll.callsFake((resultId: number) => resultId === id('gray_wool') ? templates : []);
  t.falsy((await f.invoke('craft-item', { outputItem: ' GRAY_WOOL ' })).isError);
  t.is(f.authority.count(id('gray_wool')), 1);
  t.is(f.authority.count(id('light_gray_dye')), 1);
  t.is(JSON.stringify(templates), beforeTemplates);
  t.is(JSON.stringify(registry.recipes), beforeRecipes);
});

test('dye alternatives: cancellation after one click fences without cleanup or batch retry', async t => {
  const controller = new AbortController();
  const f = fixture([['white_wool', 4], ['cyan_dye', 7]], {
    signal: controller.signal, duringClick: () => controller.abort(new Error('Synthetic cancellation'))
  });
  const result = await f.invoke('craft-item', { outputItem: 'cyan_wool', amount: 3 });
  t.true(result.isError);
  t.regex(result.content[0].text, /No automatic retry/);
  t.is(f.writes.length, 1);
  t.truthy(f.authority.fence);
  t.true(f.bot.craft.notCalled);
});

test('dye alternatives: a rejected click times out and remains fenced on a second request', async t => {
  const f = fixture([['white_wool', 4], ['cyan_dye', 7]], { reject: true });
  const result = await f.invoke('craft-item', { outputItem: 'cyan_wool', amount: 3 });
  t.true(result.isError);
  t.regex(result.content[0].text, /No automatic retry/);
  t.is(f.writes.length, 1);
  t.truthy(f.authority.fence);
  t.true((await f.invoke('craft-item', { outputItem: 'cyan_wool' })).isError);
  t.is(f.writes.length, 1);
  t.is(f.authority.count(id('white_wool')), 4);
});

test('dye alternatives: successful output cannot hide an unrelated authoritative loss', async t => {
  const f = fixture([['white_wool', 4], ['cyan_dye', 7], ['stone', 8]], { extraLoss: true });
  const result = await f.invoke('craft-item', { outputItem: 'cyan_wool', amount: 3 });
  t.true(result.isError);
  t.regex(result.content[0].text, /conservation/);
  t.truthy(f.authority.fence);
  const writes = f.writes.length;
  t.true((await f.invoke('craft-item', { outputItem: 'cyan_wool' })).isError);
  t.is(f.writes.length, writes);
});

test('dye alternatives: pre-cancelled request sends no click and creates no fence', async t => {
  const controller = new AbortController();
  controller.abort(new Error('Synthetic cancellation before dispatch'));
  const f = fixture([['white_wool', 4], ['cyan_dye', 7]], { signal: controller.signal });
  t.true((await f.invoke('craft-item', { outputItem: 'cyan_wool' })).isError);
  t.is(f.writes.length, 0);
  t.is(f.authority.fence, null);
});

test('dye alternatives: optimistic local ingredients cannot replace authoritative inventory', async t => {
  const f = fixture([['cyan_dye', 7]]);
  f.inventory.updateSlot(10, item('white_wool', 4));
  const result = await f.invoke('craft-item', { outputItem: 'cyan_wool' });
  t.true(result.isError);
  t.regex(result.content[0].text, /Missing ingredient/);
  t.is(f.writes.length, 0);
  t.is(f.authority.fence, null);
});

test('dye alternatives: raw recipes never become an execution fallback for unrelated items', async t => {
  const f = fixture([['birch_log', 2]]);
  f.bot.recipesFor.returns([]);
  t.regex((await f.invoke('can-craft', { itemName: 'birch_planks' })).content[0].text, /Yes, can craft/);
  t.true((await f.invoke('craft-item', { outputItem: 'birch_planks' })).isError);
  t.is(f.writes.length, 0);
  t.true(f.bot.craft.notCalled);
});
