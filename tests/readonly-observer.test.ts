import test from 'ava';
import { EventEmitter, once } from 'node:events';
import { request, createServer } from 'node:http';
import { io as connect, type Socket } from 'socket.io-client';
import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import type { InventoryAuthority } from '../src/inventory-authority.js';
import { observerSnapshot, startReadonlyObserver, validateObserverPort } from '../src/readonly-observer.js';

function fixture() {
  let actions = 0;
  const action = () => { actions++; throw Error('Observer tried a gameplay action'); };
  const bot = Object.assign(new EventEmitter(), { version: '1.21.1', username: 'fixture',
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0 },
    entities: {}, world: { async getColumnAt() { return null; }, raycast: action },
    health: 20, food: 18, oxygenLevel: 20, game: { dimension: 'overworld' }, time: { timeOfDay: 6000 },
    inventory: { slots: [{ name: 'optimistic_fake_item' }] }, currentWindow: null,
    clickWindow: action, setControlState: action, quit: action, chat: action, _client: { write: action },
    secretConfiguration: 'do-not-export', privateAssistantData: 'do-not-export' });
  const slots = Array(46).fill(null);
  slots[9] = { name: 'stone', type: 1, count: 12, components: [{ type: 'custom_name', data: 'private' }], nbt: { value: 'private' } };
  const authority = Object.assign(new EventEmitter(), { frames: new Map([[0, { id: 0, slots, fullRevision: 1, inventoryStart: 9, inventoryEnd: 45 }]]),
    ended: false, cursorKnown: true, cursor: null, sequence: 1, fence: null });
  return { bot: bot as unknown as Bot, authority: authority as unknown as InventoryAuthority, actions: () => actions };
}
function http(url: string, options: { method?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = request(url, options, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', value => { body += value; });
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body }));
    }); req.once('error', reject); req.end();
  });
}
function socketEvent(socket: Socket, name: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Missing socket event: ' + name)), 3000);
    socket.once(name, (...args: unknown[]) => { clearTimeout(timer); resolve(args); });
  });
}
const socketOptions = { path: '/viewer/socket.io', transports: ['websocket'], reconnection: false, timeout: 1000 };

test('observer port validates before startup, including explicit random port', t => {
  t.is(validateObserverPort(undefined), null); t.is(validateObserverPort('0'), 0); t.is(validateObserverPort('3100'), 3100);
  for (const port of ['-1', '80', '65536', ' 3100', '3e3', '0012', '127.0.0.1:3000']) t.throws(() => validateObserverPort(port));
});

test('observer exposes only sanitized server inventory, never optimistic slots or arbitrary state', t => {
  const f = fixture(); const snapshot = observerSnapshot(f.bot, f.authority);
  t.is(snapshot.inventory.slots[9]?.name, 'stone'); t.is(snapshot.inventory.slots[9]?.count, 12);
  t.is(snapshot.oxygen, null, 'an unverified native cache must not become a dashboard oxygen reading');
  t.false(snapshot.oxygenEvidence.known);
  const text = JSON.stringify(snapshot);
  for (const secret of ['do-not-export', 'private', 'components', 'nbt', 'optimistic_fake_item', 'fixture']) t.false(text.includes(secret));
  f.authority.frames.clear(); t.false(observerSnapshot(f.bot, f.authority).inventory.ready);
  t.is(f.actions(), 0);
});

test.serial('HTTP observer serves dashboard, official renderer/assets and blocks foreign origins, hosts and mutation methods', async t => {
  const f = fixture(); const observer = await startReadonlyObserver(f.bot, f.authority); t.teardown(() => observer.close());
  t.regex(observer.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const page = await http(observer.url); t.is(page.status, 200); t.true(page.body.includes('read-only')); t.is(page.headers['cache-control'], 'no-store');
  t.is((await http(observer.url + 'viewer/')).status, 200);
  t.is((await http(observer.url + 'viewer/index.js')).status, 200);
  t.is((await http(observer.url + 'textures/stone.png')).status, 200);
  const worker = await http(observer.url + 'viewer/worker.js', { method: 'HEAD' });
  t.true(String(worker.headers['content-security-policy']).includes("connect-src 'none'"));
  t.false(String(page.headers['content-security-policy']).includes('unsafe-eval'));
  t.is((await http(observer.url + 'api/snapshot')).status, 200);
  t.is((await http(observer.url + 'api/snapshot', { method: 'POST' })).status, 405);
  t.is((await http(observer.url, { headers: { Host: 'malicious.example' } })).status, 403);
  t.is((await http(observer.url, { headers: { Origin: 'https://malicious.example' } })).status, 403);
  t.is((await http(observer.url, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  t.is((await http(observer.url + '.env')).status, 404);
  t.is(f.actions(), 0);
});

test.serial('renderer socket receives observations but browser application input has no gameplay path', async t => {
  const f = fixture(); const before = f.bot.listenerCount('move');
  const observer = await startReadonlyObserver(f.bot, f.authority); t.teardown(() => observer.close());
  const socket = connect(observer.url, socketOptions); t.teardown(() => socket.disconnect());
  const [version] = await socketEvent(socket, 'version'); t.is(version, '1.21.1');
  t.is(f.bot.listenerCount('move'), before + 1);
  socket.emit('mouseClick', { origin: { x: 0, y: 64, z: 0 }, direction: { x: 1, y: 0, z: 0 }, button: 0 });
  await new Promise(resolve => setTimeout(resolve, 20)); t.true(socket.connected); t.is(f.actions(), 0);
  const disconnected = socketEvent(socket, 'disconnect'); socket.emit('setControlState', { forward: true }); await disconnected;
  t.is(f.actions(), 0); t.is(f.bot.listenerCount('move'), before);
  t.is(f.bot.listenerCount('entitySpawn'), 0); t.is(f.bot.listenerCount('chunkColumnUnload'), 0);
});

test.serial('renderer rejects cross-origin websocket upgrades', async t => {
  const f = fixture(); const observer = await startReadonlyObserver(f.bot, f.authority); t.teardown(() => observer.close());
  const socket = connect(observer.url, { ...socketOptions, extraHeaders: { Origin: 'https://malicious.example' } }); t.teardown(() => socket.disconnect());
  await socketEvent(socket, 'connect_error'); t.false(socket.connected); t.is(f.actions(), 0);
});

test.serial('repeated viewer connections and idempotent shutdown remove all game listeners', async t => {
  const f = fixture(); const observer = await startReadonlyObserver(f.bot, f.authority);
  for (let i = 0; i < 3; i++) {
    const socket = connect(observer.url, socketOptions); await socketEvent(socket, 'version'); socket.disconnect();
    await new Promise(resolve => setTimeout(resolve, 20)); t.is(f.bot.listenerCount('move'), 0);
  }
  await observer.close(); await observer.close();
  t.is(f.bot.listenerCount('end'), 0); t.is(f.bot.listenerCount('respawn'), 0); t.is(f.actions(), 0);
  await t.throwsAsync(http(observer.url));
});

test.serial('observer closes occupied-port failure without adding game listeners', async t => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.teardown(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing test socket');
  const f = fixture(); await t.throwsAsync(startReadonlyObserver(f.bot, f.authority, { port: address.port }), { code: 'EADDRINUSE' });
  t.is(f.bot.listenerCount('end'), 0); t.is(f.actions(), 0);
});

test.serial('browser-compatible polling transport preserves same-origin checks', async t => {
  const f = fixture(); const observer = await startReadonlyObserver(f.bot, f.authority); t.teardown(() => observer.close());
  const socket = connect(observer.url, { ...socketOptions, transports: ['polling', 'websocket'], extraHeaders: { Origin: observer.url.slice(0, -1) } });
  t.teardown(() => socket.disconnect());
  const [version] = await socketEvent(socket, 'version'); t.is(version, '1.21.1'); t.is(f.actions(), 0);
});

test.serial('viewer connection cap refuses extra streams and dimension changes clean all listeners', async t => {
  const f = fixture(); const observer = await startReadonlyObserver(f.bot, f.authority); t.teardown(() => observer.close());
  const sockets: Socket[] = []; t.teardown(() => sockets.forEach(socket => socket.disconnect()));
  for (let i = 0; i < 4; i++) { const socket = connect(observer.url, { ...socketOptions, forceNew: true }); sockets.push(socket); await socketEvent(socket, 'version'); }
  const extra = connect(observer.url, { ...socketOptions, forceNew: true }); sockets.push(extra); await socketEvent(extra, 'connect_error');
  t.is(f.bot.listenerCount('move'), 4);
  const disconnects = sockets.slice(0, 4).map(socket => socketEvent(socket, 'disconnect'));
  f.bot.emit('respawn'); await Promise.all(disconnects);
  t.is(f.bot.listenerCount('move'), 0); t.is(f.actions(), 0);
});

test.serial('game end shuts down the read-only service without issuing cleanup gameplay actions', async t => {
  const f = fixture(); const observer = await startReadonlyObserver(f.bot, f.authority);
  f.bot.emit('end', 'fixture'); await observer.close();
  await t.throwsAsync(http(observer.url)); t.is(f.actions(), 0); t.is(f.bot.listenerCount('end'), 0);
});


test.serial('3D chunk observations strip block-entity NBT before reaching browsers', async t => {
  const f = fixture();
  Object.assign(f.bot.world, { async getColumnAt() { return { toJson: () => JSON.stringify({ minY: -64, sections: [], blockEntities: { sign: { text: 'private fixture text' } } }) }; } });
  const observer = await startReadonlyObserver(f.bot, f.authority); t.teardown(() => observer.close());
  const socket = connect(observer.url, socketOptions); t.teardown(() => socket.disconnect());
  const [value] = await socketEvent(socket, 'loadChunk');
  const chunk = JSON.parse((value as { chunk: string }).chunk);
  t.deepEqual(chunk.blockEntities, {}); t.is(chunk.minY, -64); t.false(JSON.stringify(value).includes('private fixture text'));
});
