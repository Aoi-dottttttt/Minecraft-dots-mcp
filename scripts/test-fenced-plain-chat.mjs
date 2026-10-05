#!/usr/bin/env node
// Offline integration test: real runtime, ToolFactory and InventoryAuthority;
// synthetic loopback protocol-767 server only. No bridge or credentials.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Vec3 } from 'vec3';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// A positional root supports the negative control against the unmodified tree.
const runtimeRoot = process.argv[2] ? resolve(process.argv[2]) : root;
const require = createRequire(import.meta.url);
const mc = require('minecraft-protocol');
const data = require('minecraft-data')('1.21.1');
const nbt = require('prismarine-nbt');
const Item = require('prismarine-item')('1.21.1');
const Chunk = require('prismarine-chunk')('1.21.1');
const sandbox = mkdtempSync(join(tmpdir(), 'minecraft-fenced-chat-'));
const checks = [], packets = [], sockets = new Set();
let gameClient, connections = 0, joins = 0, transport, client, server, failure;
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const text = result => result?.content?.find(part => part.type === 'text')?.text;
const chats = () => packets.filter(packet => packet.name === 'chat_message');
const check = name => { checks.push(name); process.stderr.write(`PASS ${name}\n`); };
async function until(predicate, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(20);
  }
  throw Error(`${label} timed out`);
}
const watchdog = setTimeout(() => {
  process.stderr.write('Fenced plain-chat test watchdog expired\n');
  process.exit(1);
}, 45000);

try {
  server = mc.createServer({ host: '127.0.0.1', port: 0, version: '1.21.1', 'online-mode': false, hideErrors: true, checkTimeoutInterval: 60000 });
  await once(server, 'listening');
  server.socketServer.on('connection', socket => {
    connections++; sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  server.on('playerJoin', player => {
    gameClient = player; joins++;
    player.on('error', () => {});
    player.on('packet', (packet, meta) => packets.push({ name: meta.name, packet }));
    player.write('login', { ...data.loginPacket, entityId: 1 });
    player.write('player_info', { action: { add_player: true, update_game_mode: true, update_listed: true }, data: [{ uuid: player.uuid, player: { name: player.username, properties: [] }, gamemode: 0, listed: 1 }] });
    const chunk = new Chunk({ minY: -64, worldHeight: 384 });
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) chunk.setBlockStateId(new Vec3(x, 63, z), data.blocksByName.stone.defaultState);
    player.write('map_chunk', { x: 0, z: 0, heightmaps: nbt.comp({}), chunkData: chunk.dump(), blockEntities: [], skyLightMask: [], blockLightMask: [], emptySkyLightMask: [], emptyBlockLightMask: [], skyLight: [], blockLight: [] });
    player.write('position', { x: 8.5, y: 64, z: 8.5, pitch: 0, yaw: 0, flags: {}, teleportId: 1 });
    player.write('update_health', { health: 20, food: 20, foodSaturation: 5 });
    const slots = Array(46).fill(null); slots[9] = new Item(data.itemsByName.stone.id, 8);
    player.write('window_items', { windowId: 0, stateId: 1, items: slots.map(item => Item.toNotch(item)), carriedItem: Item.toNotch(null) });
    // Deliberately never acknowledge window_click: actual authority must fence.
  });
  const sessionId = randomUUID();
  transport = new StdioClientTransport({ command: process.execPath, args: [join(runtimeRoot, 'runtime/minecraft-server.mjs'), '--user-started-session', String(server.socketServer.address().port), '--session-id', sessionId, '--state-dir', join(sandbox, 'gameplay-state')], cwd: runtimeRoot, env: { PATH: process.env.PATH || '', HOME: sandbox, LANG: 'C.UTF-8' }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', part => { stderr += part; });
  client = new Client({ name: 'offline-fenced-plain-chat-test', version: '1.0.0' });
  await client.connect(transport, { timeout: 10000 });
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const status = async () => JSON.parse(text(await call('get-session-status')));
  await until(async () => { const value = await status(); return value.ready && value.inventoryAuthority.mutationReady; }, 'runtime ready: ' + stderr, 15000);
  const catalog = await client.listTools();
  const sendChat = catalog.tools.find(tool => tool.name === 'send-chat');
  assert.ok(sendChat);
  assert.notEqual(sendChat.annotations?.readOnlyHint, true, 'Chat must never be advertised as read-only');
  for (const name of ['send_packet', 'run_command', 'connect_bot', 'reconnect_bot']) assert.ok(!catalog.tools.some(tool => tool.name === name), `Excluded tool ${name}`);
  check('existing mutating plain-chat tool retained; raw and lifecycle tools remain absent');

  // A chat already queued inside ToolFactory must observe the stop gate once
  // the prior movement aborts. The inventory-only exception cannot bypass it.
  const initial = await status();
  const moving = call('move-controls', { controls: { forward: true }, durationMs: 4000 });
  await until(async () => { const p = (await status()).position; return Math.hypot(p.x - initial.position.x, p.z - initial.position.z) > 0.15; }, 'movement before stop');
  const queued = call('send-chat', { message: 'must not send during stop drain' });
  await sleep(30);
  const stopped = await call('stop-movement');
  assert.notEqual(stopped.isError, true, text(stopped));
  assert.equal((await moving).isError, true);
  const queuedResult = await queued;
  assert.equal(queuedResult.isError, true);
  assert.match(text(queuedResult), /Safety stop.*fenced/);
  assert.equal(chats().length, 0);
  assert.equal((await status()).controlFence, null);
  check('queued plain chat remains serialized and rejects during safety-stop drain');

  const equipmentArgs = { inventorySlot: 9, destination: 'hand', timeoutMs: 150 };
  const equipment = await call('equip-inventory-slot', equipmentArgs);
  assert.equal(equipment.isError, true);
  const clicks = packets.filter(packet => packet.name === 'window_click').length;
  assert.equal(clicks, 1);
  const fenced = await status();
  assert.ok(fenced.inventoryAuthority.fence, 'Actual unacknowledged inventory click must latch authority');
  assert.equal(fenced.inventoryAuthority.mutationReady, false);
  const message = 'fenced offline plain chat '.padEnd(220, 'x');
  const sent = await call('send-chat', { message });
  assert.notEqual(sent.isError, true, text(sent));
  await until(() => chats().length === 1, 'one captured plain-chat packet');
  assert.equal(chats()[0].packet.message, message);
  assert.deepEqual((await status()).inventoryAuthority, fenced.inventoryAuthority, 'Sending chat cannot alter or clear inventory authority');
  check('220-character plain chat alone sends under an actual inventory fence; fence remains unchanged');

  const rateLimited = await call('send-chat', { message: 'must not send again yet' });
  assert.equal(rateLimited.isError, true);
  assert.match(text(rateLimited), /Chat rate limit/);
  const invalid = ['', 'x'.repeat(221), '/help', '   /help', '\u00a0/help', ...Array.from({ length: 32 }, (_, code) => `blocked${String.fromCharCode(code)}text`), 'blocked\x7ftext'];
  for (const message of invalid) {
    const rejected = await call('send-chat', { message });
    assert.equal(rejected.isError, true, `Invalid message must reject: ${JSON.stringify(message)}`);
    assert.match(text(rejected), /validat|invalid|at least|at most|Ordinary game chat/i, 'Malformed messages must fail validation, not merely hit the rate gate');
    assert.doesNotMatch(text(rejected), /Chat rate limit|Inventory safety lock/);
  }
  assert.equal(chats().length, 1);
  check('four-second rate gate and empty/oversize/slash/all-C0/DEL validation reject without packets');

  for (const [name, args] of [
    ['chat', { message: 'alias stays blocked' }],
    ['whisper', { username: 'FixturePlayer', message: 'whisper stays blocked' }],
    ['game-command', { action: 'help' }],
    ['move-controls', { controls: { forward: true }, durationMs: 50 }],
    ['equip-inventory-slot', equipmentArgs]
  ]) {
    const rejected = await call(name, args);
    assert.equal(rejected.isError, true, `${name} must remain inventory-fenced`);
    assert.match(text(rejected), /Inventory safety lock/);
  }
  assert.equal(packets.filter(packet => packet.name === 'window_click').length, clicks);
  assert.equal(chats().length, 1);
  assert.equal(packets.filter(packet => /chat_command/.test(packet.name)).length, 0);
  assert.notEqual((await call('read-chat')).isError, true);
  assert.deepEqual((await status()).inventoryAuthority, fenced.inventoryAuthority);
  check('chat alias, whisper, typed commands, movement and inventory mutations remain fenced; reads still work');

  await sleep(4100);
  assert.equal(chats().length, 1, 'Rejected chat must never be queued or replayed after its rate interval');
  assert.notEqual((await call('send-chat', { message: 'x' })).isError, true);
  await until(() => chats().length === 2, 'one-character plain-chat packet after rate interval');
  assert.equal(chats()[1].packet.message, 'x');
  assert.deepEqual((await status()).inventoryAuthority, fenced.inventoryAuthority);
  check('one-character chat succeeds after four seconds; rejected sends were not deferred or replayed');

  gameClient.write('update_health', { health: 0, food: 20, foodSaturation: 5 });
  await until(async () => (await status()).dead, 'runtime death state');
  const deadChat = await call('send-chat', { message: 'must not send while dead' });
  assert.equal(deadChat.isError, true);
  assert.match(text(deadChat), /not ready/);
  assert.equal(chats().length, 2);
  check('dead session rejects plain chat before dispatch');

  gameClient.end('offline fixture ended');
  await until(async () => (await status()).ended, 'runtime disconnect');
  const endedChat = await call('send-chat', { message: 'must not send after disconnect' });
  assert.equal(endedChat.isError, true);
  assert.match(text(endedChat), /not ready/);
  assert.equal(chats().length, 2);
  assert.equal(connections, 1); assert.equal(joins, 1);
  check('disconnected session rejects plain chat; one synthetic game connection was used');
} catch (error) {
  failure = error;
  process.stderr.write(`${error.stack}\n`);
} finally {
  await client?.close().catch(() => {});
  await transport?.close().catch(() => {});
  for (const socket of sockets) socket.destroy();
  server?.close();
  clearTimeout(watchdog);
  rmSync(sandbox, { recursive: true, force: true });
}
const report = { passed: !failure, checks, target: 'synthetic loopback Minecraft 1.21.1 / protocol 767', actualRuntime: 'runtime/minecraft-server.mjs', liveServerUsed: false, credentialsUsed: false, fullControllerLifecycleVerified: false, ...(failure ? { error: failure.message } : {}) };
process.stdout.write(JSON.stringify(report, null, 2) + '\n', () => process.exit(failure ? 1 : 0));
