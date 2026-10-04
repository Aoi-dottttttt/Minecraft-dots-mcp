// Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
import test from 'ava';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import type { BotConnection } from '../src/bot-connection.js';
import { ToolFactory } from '../src/tool-factory.js';
import { MessageStore } from '../src/message-store.js';
import { installInventoryAuthority } from '../src/inventory-authority.js';
import { registerPositionTools } from '../src/tools/position-tools.js';
import { registerInventoryTools } from '../src/tools/inventory-tools.js';
import { registerBlockTools } from '../src/tools/block-tools.js';
import { registerEntityTools } from '../src/tools/entity-tools.js';
import { registerChatTools } from '../src/tools/chat-tools.js';
import { registerFlightTools } from '../src/tools/flight-tools.js';
import { registerGameStateTools } from '../src/tools/gamestate-tools.js';
import { registerCraftingTools } from '../src/tools/crafting-tools.js';
import { registerFurnaceTools } from '../src/tools/furnace-tools.js';

const legacyTools = [
  'can-craft', 'craft-item', 'detect-gamemode', 'dig-block', 'equip-item',
  'find-blocks', 'find-entity', 'find-item', 'fly-to', 'get-block-info',
  'get-position', 'get-recipe', 'jump', 'list-inventory', 'list-recipes',
  'look-at', 'move-in-direction', 'move-to-position', 'place-block',
  'read-chat', 'send-chat', 'smelt-item'
];
const legacySchemas = JSON.parse(readFileSync(new URL('./fixtures/legacy-tool-schema.json', import.meta.url), 'utf8')) as Array<{ name: string; properties: string[]; required: string[] }>;

async function createFixture() {
  let connected = true;
  const chat: string[] = [];
  const require = createRequire(import.meta.url);
  const registry = require('prismarine-registry')('1.21.1');
  const Item = require('prismarine-item')(registry);
  const log = new Item(registry.itemsByName.oak_log.id, 8);
  log.slot = 9;
  const slots = Array(46).fill(null);
  slots[9] = log;
  const bot = Object.assign(new EventEmitter(), {
    version: '1.21.1', registry, _client: new EventEmitter(),
    entity: { position: new Vec3(12.75, 64, -4.1) },
    inventory: { id: 0, slots, selectedItem: null, items: () => [log], updateSlot: (slot: number, item: unknown) => { slots[slot] = item; } },
    chat: (message: string) => { chat.push(message); }
  }) as unknown as Bot;
  installInventoryAuthority(bot);
  bot._client.emit('window_items', { windowId: 0, stateId: 1, items: slots.map(item => Item.toNotch(item)), carriedItem: Item.toNotch(null) });
  const connection = {
    checkConnectionAndReconnect: async () => ({ connected, message: 'Offline fixture is disconnected' }),
    getBot: () => connected ? bot : null,
    isConnected: () => connected
  } as unknown as BotConnection;
  const server = new McpServer({ name: 'minecraft-mcp-server', version: 'integration-fixture' });
  const factory = new ToolFactory(server, connection);
  const messageStore = new MessageStore();
  const getBot = () => bot;
  registerPositionTools(factory, getBot);
  registerInventoryTools(factory, getBot);
  registerBlockTools(factory, getBot);
  registerEntityTools(factory, getBot);
  registerChatTools(factory, getBot, messageStore);
  registerFlightTools(factory, getBot);
  registerGameStateTools(factory, getBot);
  registerCraftingTools(factory, getBot);
  registerFurnaceTools(factory, getBot);
  const client = new Client({ name: 'offline-regression-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client, chat, messageStore,
    disconnect: () => { connected = false; },
    close: async () => { await client.close(); await server.close(); }
  };
}

test('real MCP SDK initialize and tools/list preserve every legacy tool and schema', async (t) => {
  const fixture = await createFixture();
  t.teardown(() => fixture.close());
  t.is(fixture.client.getServerVersion()?.name, 'minecraft-mcp-server');
  t.truthy(fixture.client.getServerCapabilities()?.tools);
  const { tools } = await fixture.client.listTools();
  const names = tools.map(tool => tool.name);
  t.is(new Set(names).size, names.length);
  for (const name of legacyTools) t.true(names.includes(name), `Legacy tool missing: ${name}`);
  for (const tool of tools) t.is(tool.inputSchema.type, 'object');
  for (const legacy of legacySchemas) {
    const current = tools.find(tool => tool.name === legacy.name)!;
    const properties = Object.keys(current.inputSchema.properties ?? {});
    for (const property of legacy.properties) t.true(properties.includes(property), `${legacy.name}: missing argument ${property}`);
    t.deepEqual([...(current.inputSchema.required ?? [])].sort(), legacy.required, `${legacy.name}: required arguments changed`);
  }
  const equip = tools.find(tool => tool.name === 'equip-item');
  t.true(equip?.inputSchema.required?.includes('itemName'));
  const move = tools.find(tool => tool.name === 'move-to-position');
  for (const axis of ['x', 'y', 'z']) t.true(move?.inputSchema.required?.includes(axis));
});

test('real MCP SDK tools/call returns compatible inventory, position and chat text', async (t) => {
  const fixture = await createFixture();
  t.teardown(() => fixture.close());
  const inventory = await fixture.client.callTool({ name: 'list-inventory', arguments: {} });
  t.not(inventory.isError, true);
  t.true(JSON.stringify(inventory.content).includes('oak_log'));
  const position = await fixture.client.callTool({ name: 'get-position', arguments: {} });
  t.not(position.isError, true);
  t.true(JSON.stringify(position.content).includes('(12, 64, -5)'));
  const message = 'offline integration fixture';
  const sent = await fixture.client.callTool({ name: 'send-chat', arguments: { message } });
  t.not(sent.isError, true);
  t.deepEqual(fixture.chat, [message]);
  fixture.messageStore.addMessage('FixturePlayer', 'fixture incoming message');
  const received = await fixture.client.callTool({ name: 'read-chat', arguments: { count: 1 } });
  t.true(JSON.stringify(received.content).includes('fixture incoming message'));
});

test('real MCP SDK rejects malformed arguments and unknown tools without gameplay side effects', async (t) => {
  const fixture = await createFixture();
  t.teardown(() => fixture.close());
  const malformed = await fixture.client.callTool({ name: 'send-chat', arguments: {} });
  t.true(malformed.isError);
  t.deepEqual(fixture.chat, []);
  const unknown = await fixture.client.callTool({ name: 'missing-tool-fixture', arguments: {} });
  t.true(unknown.isError);
});

test('real MCP SDK exposes disconnected state as tool error instead of success', async (t) => {
  const fixture = await createFixture();
  t.teardown(() => fixture.close());
  fixture.disconnect();
  const response = await fixture.client.callTool({ name: 'list-inventory', arguments: {} });
  t.true(response.isError);
  t.true(JSON.stringify(response.content).includes('disconnected'));
});
