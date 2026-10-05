import test from 'ava';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { installInventoryAuthority, type ServerItem } from '../src/inventory-authority.js';
import { readBookVerified } from '../src/book-observation.js';
import { registerCompleteControls } from '../src/complete-controls.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { BotConnection } from '../src/bot-connection.js';

const require = createRequire(import.meta.url);
function fixture(name = 'writable_book', data: unknown = { pages: [{ content: 'First page' }, { content: 'Second page' }] }, version = '1.21.1') {
  const registry = require('prismarine-registry')(version);
  const Item = require('prismarine-item')(registry);
  const item = new Item(registry.itemsByName[name].id, 1);
  if (registry.supportFeature('itemsWithComponents')) {
    item.components = data === null ? [] : [{ type: name === 'written_book' ? 'written_book_content' : 'writable_book_content', data }];
    item.removedComponents = [];
  } else item.nbt = data;
  const slots: Array<ServerItem | null> = Array(46).fill(null);
  slots[36] = item;
  const writes: unknown[] = [];
  const client = Object.assign(new EventEmitter(), { write: (...args: unknown[]) => { writes.push(args); } });
  const bot = Object.assign(new EventEmitter(), {
    registry, version, _client: client, quickBarSlot: 0, currentWindow: null,
    inventory: { slots: Array(46).fill(null), selectedItem: null, updateSlot() {} }
  }) as unknown as Bot;
  const authority = installInventoryAuthority(bot);
  let stateId = 1;
  const sync = () => client.emit('window_items', { windowId: 0, stateId: stateId++, items: slots.map(value => Item.toNotch(value)), carriedItem: Item.toNotch(null) });
  sync();
  return { bot, authority, item, slots, sync, writes, Item };
}
const textTag = (text: string) => ({ type: 'string', value: text });
const legacyBook = (pages: string[]) => ({ type: 'compound', name: '', value: { pages: { type: 'list', value: { type: 'string', value: pages } }, title: textTag('Fixture title'), author: textTag('Fixture author') } });

test('reads protocol-767 writable pages only from independent authoritative inventory', t => {
  const s = fixture();
  s.bot.inventory.slots[36] = s.item;
  s.item.components[0].data.pages[0].content = 'Optimistic unsent local edit';
  const result = readBookVerified(s.bot);
  t.deepEqual(result.pages.map(page => page.text), ['First page', 'Second page']);
  t.true(result.untrusted);
  t.is(result.evidence, 'server_inventory_packets');
  t.is(result.source.inventorySlot, 36);
  t.is(result.source.protocolVersion, 767);
  t.is(result.source.slotRevision, 1);
  t.deepEqual(s.writes, []);
});

test('preserves raw and filtered pages with explicit truncation and stable pagination', t => {
  const s = fixture('writable_book', { pages: [{ content: 'abcdefgh', filteredContent: 'filtered' }, { content: 'Next' }, { content: 'Last' }] });
  const first = readBookVerified(s.bot, { startPage: 1, pageCount: 1, maxCharsPerPage: 4 });
  t.deepEqual(first.pages, [{ page: 1, text: 'abcd', textTruncated: true, filteredText: 'filt', filteredTextTruncated: true }]);
  t.is(first.nextPage, 2);
  const second = readBookVerified(s.bot, { startPage: 2, expectedBookVersion: first.bookVersion });
  t.deepEqual(second.pages.map(page => page.text), ['Next', 'Last']);
  t.false(second.hasMore);
  t.is(second.nextPage, null);
  t.is(second.bookVersion, first.bookVersion);
  t.deepEqual(s.writes, []);
});

test('book version detects server edits but not unrelated inventory changes', t => {
  const s = fixture();
  const first = readBookVerified(s.bot, { pageCount: 1 });
  s.slots[9] = new s.Item(s.bot.registry.itemsByName.stone.id, 2);
  s.sync();
  t.notThrows(() => readBookVerified(s.bot, { startPage: 2, expectedBookVersion: first.bookVersion }));
  s.item.components[0].data.pages[1].content = 'Server-confirmed replacement';
  s.sync();
  t.throws(() => readBookVerified(s.bot, { startPage: 2, expectedBookVersion: first.bookVersion }), { message: /content changed/ });
  t.not(readBookVerified(s.bot).bookVersion, first.bookVersion);
});

test('reads 767 signed NBT chat pages through the installed renderer without rich actions', t => {
  const content = { type: 'compound', value: { text: textTag('Hello '), extra: { type: 'list', value: { type: 'compound', value: [{ text: textTag('world'), clickEvent: { type: 'compound', value: { action: textTag('run_command'), value: textTag('/say fixture') } } }] } } } };
  const s = fixture('written_book', { rawTitle: 'Fixture title', filteredTitle: 'Filtered title', author: 'Fixture author', generation: 1, resolved: true, pages: [{ content, filteredContent: textTag('Filtered page') }] });
  const result = readBookVerified(s.bot);
  t.is(result.title, 'Fixture title');
  t.is(result.filteredTitle, 'Filtered title');
  t.is(result.author, 'Fixture author');
  t.is(result.generation, 1);
  t.true(result.resolved);
  t.true(result.signedTextIsPlainTextProjection);
  t.is(result.pages[0].text, 'Hello world');
  t.is(result.pages[0].filteredText, 'Filtered page');
  t.false(JSON.stringify(result).includes('/say fixture'));
  t.deepEqual(s.writes, []);
});

test('legacy NBT writable and signed JSON content have deterministic read-only decoding', t => {
  const writable = fixture('writable_book', legacyBook(['Legacy text', 'Second']), '1.20.4');
  t.is(readBookVerified(writable.bot).pages[0].text, 'Legacy text');
  const signed = fixture('written_book', legacyBook([JSON.stringify({ text: 'Signed ', extra: [{ text: 'page' }] })]), '1.20.4');
  const result = readBookVerified(signed.bot);
  t.is(result.format, 'legacy_nbt');
  t.is(result.pages[0].text, 'Signed page');
  t.is(result.source.protocolVersion, 765);
  t.deepEqual([...writable.writes, ...signed.writes], []);
});

test('empty default writable book is explicit; missing signed content is not fabricated', t => {
  const writable = fixture('writable_book', null);
  const result = readBookVerified(writable.bot);
  t.is(result.format, 'empty_default');
  t.is(result.totalPages, 0);
  t.deepEqual(result.pages, []);
  t.is(result.nextPage, null);
  t.throws(() => readBookVerified(fixture('written_book', null).bot), { message: /unavailable/ });
  writable.item.removedComponents = ['writable_book_content']; writable.sync();
  t.throws(() => readBookVerified(writable.bot), { message: /unavailable/ });
});

test('read remains available through inventory uncertainty and never clears the fence', t => {
  const s = fixture();
  s.authority.block('Neutral uncertain fixture');
  const revision = s.authority.sequence;
  const result = readBookVerified(s.bot);
  t.true(result.mutationFencePresent);
  t.is(s.authority.fence, 'Neutral uncertain fixture');
  t.is(s.authority.sequence, revision);
  t.deepEqual(s.writes, []);
});

test('reads only own player slots while a container is open, never a container book', t => {
  const s = fixture();
  const chestSlots = Array(63).fill(null);
  const privateBook = new s.Item(s.bot.registry.itemsByName.writable_book.id, 1);
  privateBook.components = [{ type: 'writable_book_content', data: { pages: [{ content: 'Container-only fixture' }] } }];
  privateBook.removedComponents = [];
  chestSlots[0] = privateBook;
  chestSlots[54] = s.item; // Player slot 36, mapped into a 27-slot menu.
  s.bot._client.emit('open_window', { windowId: 7 });
  s.bot._client.emit('window_items', { windowId: 7, stateId: 1, items: chestSlots.map(value => s.Item.toNotch(value)), carriedItem: s.Item.toNotch(null) });
  const result = readBookVerified(s.bot, { inventorySlot: 36 });
  t.is(result.pages[0].text, 'First page');
  t.throws(() => readBookVerified(s.bot, { inventorySlot: 0 }));
  t.false(JSON.stringify(result).includes('Container-only'));
  t.deepEqual(s.writes, []);
});

test('storage and offhand slots are explicit and all invalid ranges reject without writes', t => {
  const s = fixture(); s.slots[45] = s.item; s.slots[9] = s.item; s.sync();
  t.is(readBookVerified(s.bot, { inventorySlot: 45 }).source.inventorySlot, 45);
  t.is(readBookVerified(s.bot, { inventorySlot: 9 }).source.inventorySlot, 9);
  for (const args of [{ inventorySlot: 46 }, { inventorySlot: 8 }, { pageCount: 11 }, { startPage: 0 }, { startPage: 3 }, { maxCharsPerPage: 4097 }, { pageCount: 0 }, { inventorySlot: 9.5 }]) t.throws(() => readBookVerified(s.bot, args));
  t.deepEqual(s.writes, []);
});

test('absent books, missing authoritative frames and ended sessions fail honestly', t => {
  t.throws(() => readBookVerified(fixture('stone').bot), { message: /does not contain/ });
  const s = fixture();
  s.bot.emit('end', 'fixture');
  t.throws(() => readBookVerified(s.bot), { message: /session ended/ });
  const fresh = fixture(); fresh.authority.frames.clear();
  t.throws(() => readBookVerified(fresh.bot), { message: /No complete authoritative snapshot/ });
  t.deepEqual([...s.writes, ...fresh.writes], []);
});

test('unknown, duplicate, excessively long or deep book content fails closed', t => {
  for (const data of [{ pages: 'not pages' }, { pages: [{}] }, { pages: Array.from({ length: 101 }, () => ({ content: 'x' })) }, { pages: [{ content: 'x'.repeat(524289) }] }, { pages: [{ content: 5 }] }]) {
    const s = fixture('writable_book', data);
    t.throws(() => readBookVerified(s.bot));
    t.deepEqual(s.writes, []);
  }
  const duplicate = fixture();
  duplicate.item.components.push({ type: 'writable_book_content', data: { pages: [] } }); duplicate.sync();
  t.throws(() => readBookVerified(duplicate.bot), { message: /duplicate/ });
  let content: unknown = textTag('Deep');
  for (let n = 0; n < 30; n++) content = { type: 'compound', value: { extra: content } };
  t.throws(() => readBookVerified(fixture('written_book', { pages: [{ content }] }).bot), { message: /structural limit/ });
});

test('signed renderer never receives excessive nesting hidden inside legacy JSON strings', t => {
  let text: unknown = { text: 'Deep' };
  for (let n = 0; n < 30; n++) text = { extra: [text] };
  const s = fixture('written_book', legacyBook([JSON.stringify(text)]), '1.20.4');
  t.throws(() => readBookVerified(s.bot), { message: /structural limit/ });
  t.deepEqual(s.writes, []);
});

test('writable and signed book fixtures round-trip through the actual protocol-767 packet codec', t => {
  const protocol = require('minecraft-protocol');
  const serializer = protocol.createSerializer({ state: 'play', isServer: true, version: '1.21.1' });
  const deserializer = protocol.createDeserializer({ state: 'play', isServer: false, version: '1.21.1' });
  for (const [name, data, expected] of [
    ['writable_book', { pages: [{ content: 'Wire writable', filteredContent: null }] }, 'Wire writable'],
    ['written_book', { rawTitle: 'Wire title', filteredTitle: null, author: 'Fixture author', generation: 0, resolved: true, pages: [{ content: textTag('Wire signed'), filteredContent: { type: 'end' } }] }, 'Wire signed']
  ] as const) {
    const s = fixture(name, data);
    s.authority.frames.clear();
    const packet = { name: 'window_items', params: { windowId: 0, stateId: 5, items: s.slots.map(value => s.Item.toNotch(value)), carriedItem: s.Item.toNotch(null) } };
    const decoded = deserializer.parsePacketBuffer(serializer.createPacketBuffer(packet)).data;
    s.bot._client.emit(decoded.name, decoded.params);
    const result = readBookVerified(s.bot);
    t.is(result.pages[0].text, expected);
    t.is(result.source.stateId, 5);
    t.deepEqual(s.writes, []);
  }
});

test.serial('guarded MCP registration exposes read-book and permits fenced read without packets', async t => {
  const s = fixture();
  Object.assign(s.bot, { entities: {}, players: {} });
  const server = new McpServer({ name: 'book-observation-fixture', version: '1.0.0' });
  const reads = new Set<string>();
  const factory = new ToolFactory(server, {
    checkConnectionAndReconnect: async () => ({ connected: !s.authority.ended }),
    assertActionAllowed: (name: string) => { if (!reads.has(name)) s.authority.assertMutationReady(); }
  } as unknown as BotConnection);
  const complete = await registerCompleteControls({ server, factory, bot: s.bot, fixture: true, legacy: new Map(), markRead: name => reads.add(name), stateRoot: '/tmp/book-observation-fixture' });
  const client = new Client({ name: 'book-observation-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.teardown(async () => { await client.close(); await server.close(); await complete.stop(); });
  t.true(complete.names.includes('read-book'));
  t.true(reads.has('read-book'));
  const catalog = await client.listTools();
  t.true(catalog.tools.some(tool => tool.name === 'read-book'));
  s.authority.block('Neutral read-only fence');
  const response = await client.callTool({ name: 'read-book', arguments: { inventorySlot: 36, pageCount: 1 } });
  t.not(response.isError, true);
  const content = response.content as Array<{ type: string; text: string }>;
  const result = JSON.parse(content[0].text);
  t.is(result.pages[0].text, 'First page');
  t.true(result.untrusted);
  t.true(result.mutationFencePresent);
  t.is(s.authority.fence, 'Neutral read-only fence');
  t.deepEqual(s.writes, []);
  const invalid = await client.callTool({ name: 'read-book', arguments: { inventorySlot: 0 } });
  t.true(invalid.isError);
  t.deepEqual(s.writes, []);
});
