#!/usr/bin/env node
// Independent, offline persistent-controller acceptance tests. No bridge,
// credentials, online authentication, or external Minecraft service is used.
// The game fixture uses the installed real minecraft-protocol 767 codec; the
// daemon uses its unmodified real Mineflayer backend and real MCP frontends.
// Run without arguments for full acceptance. Optional cases: security,
// frontend, uncertainty, backend (no IPC), paths (startup rejection only).
// Partial cases explicitly report fullControllerLifecycleVerified:false.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Vec3 } from 'vec3';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const mc = require('minecraft-protocol');
const data = require('minecraft-data')('1.21.1');
const nbt = require('prismarine-nbt');
const Item = require('prismarine-item')('1.21.1');
const Chunk = require('prismarine-chunk')('1.21.1');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const sandbox = mkdtempSync(join(tmpdir(), 'minecraft-daemon-smoke-'));
const env = { PATH: process.env.PATH || '', HOME: sandbox, LANG: 'C.UTF-8' };
const children = new Set();
const peers = new Set();
const frontends = new Set();
const fixtures = new Set();
const checks = [];
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const check = name => { checks.push(name); process.stderr.write(`PASS ${name}\n`); };
async function until(predicate, label, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try { last = await predicate(); if (last) return last; } catch (error) { last = error; }
    await sleep(25);
  }
  throw Error(`${label} timed out${last instanceof Error ? ': ' + last.message : ''}`);
}
function launch(args) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = ''; child.errors = '';
  child.stdout.on('data', data => { child.output += data; });
  child.stderr.on('data', data => { child.errors += data; });
  child.on('error', error => { child.errors += error.message; });
  children.add(child);
  return child;
}
async function exited(child, timeoutMs = 10000) {
  await until(() => child.exitCode !== null || child.signalCode !== null, 'child exit', timeoutMs);
  return child.exitCode;
}
async function daemon(dir, port) {
  const args = [join(root, 'runtime/minecraft-daemon.mjs'), ...(port ? ['--user-started-session', String(port)] : ['--offline-fixture']), '--state-dir', dir];
  const child = launch(args);
  await until(() => {
    if (child.exitCode !== null) throw Error(`Daemon exited ${child.exitCode}: ${child.errors || (existsSync(join(dir, 'error.json')) ? readFileSync(join(dir, 'error.json'), 'utf8') : '')}`);
    return existsSync(join(dir, 'session.json'));
  }, 'daemon socket');
  return child;
}
class Peer {
  constructor(socket) {
    this.socket = socket; this.pending = new Map(); this.messages = []; this.buffer = ''; this.next = 0;
    peers.add(this);
    socket.setEncoding('utf8');
    socket.on('data', data => {
      this.buffer += data;
      for (;;) {
        const end = this.buffer.indexOf('\n'); if (end === -1) break;
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line); this.messages.push(message);
        const pending = this.pending.get(message.id);
        if (pending) { clearTimeout(pending.timer); this.pending.delete(message.id); pending.resolve(message); }
      }
    });
    const failed = () => {
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(Error('Controller socket closed')); }
      this.pending.clear();
    };
    socket.on('error', failed); socket.on('close', failed);
  }
  request(op, fields = {}, id = `${++this.next}`) {
    assert.ok(!this.pending.has(id), 'Test must not reuse a pending transport request ID');
    const promise = new Promise((resolveResponse, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`IPC ${op} ${id} timed out`)); }, 15000);
      this.pending.set(id, { resolve: resolveResponse, reject, timer });
      this.socket.write(JSON.stringify({ id, op, ...(op === 'attach' ? { ipcVersion: 1 } : {}), ...fields }) + '\n');
    });
    promise.catch(() => {});
    return promise;
  }
  async okay(op, fields = {}, id) {
    const response = await this.request(op, fields, id);
    assert.equal(response.ok, true, `${op}: ${JSON.stringify(response)}`);
    return response.result;
  }
  call(name, args = {}, requestId = randomUUID(), id) { return this.request('call', { name, arguments: args, requestId }, id); }
  destroy() { this.socket.destroy(); }
}
async function peer(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));
  const socket = net.createConnection(manifest.socketPath);
  await once(socket, 'connect');
  return new Peer(socket);
}
function toolText(result) { return result?.content?.find(item => item.type === 'text')?.text; }
function gameStatus(status) { return status.backend?.status; }
async function waitReady(observer) {
  return until(async () => {
    const status = await observer.okay('status');
    return gameStatus(status)?.ready && status;
  }, 'real Mineflayer ready', 15000);
}
async function waitDetached(observer) {
  return until(async () => {
    const status = await observer.okay('status');
    return !status.controllerAttached && status;
  }, 'controller detached');
}
async function frontend(dir) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'runtime/minecraft-frontend.mjs'), '--attach', dir], cwd: root, env, stderr: 'pipe' });
  let stderr = ''; transport.stderr.on('data', data => { stderr += data; });
  const client = new Client({ name: 'persistent-controller-offline-test', version: '1.0.0' });
  client.onerror = () => {};
  const result = { client, transport, get stderr() { return stderr; } }; frontends.add(result);
  try { await client.connect(transport, { timeout: 10000 }); }
  catch (error) { throw Error(`Frontend failed: ${error.message}; ${stderr}`); }
  return result;
}
async function protocolFixture() {
  const server = mc.createServer({ host: '127.0.0.1', port: 0, version: '1.21.1', 'online-mode': false, hideErrors: true, checkTimeoutInterval: 60000 });
  const fixture = { server, client: null, joins: [], sockets: new Set(), connections: 0, packets: [], ended: 0, errors: [] };
  fixtures.add(fixture);
  server.on('error', error => { fixture.errors.push(String(error)); });
  await once(server, 'listening');
  fixture.port = server.socketServer.address().port;
  server.socketServer.on('connection', socket => {
    fixture.connections++; fixture.sockets.add(socket);
    socket.on('close', () => fixture.sockets.delete(socket)); socket.on('error', () => {});
  });
  server.on('playerJoin', client => {
    fixture.client = client; fixture.joins.push({ username: client.username, uuid: client.uuid, client });
    client.on('error', error => fixture.errors.push(String(error)));
    client.on('end', () => fixture.ended++);
    client.on('packet', (packet, meta) => fixture.packets.push({ name: meta.name, packet, at: Date.now() }));
    client.write('login', { ...data.loginPacket, entityId: 1 });
    client.write('player_info', { action: { add_player: true, update_game_mode: true, update_listed: true }, data: [{ uuid: client.uuid, player: { name: client.username, properties: [] }, gamemode: 0, listed: 1 }] });
    const chunk = new Chunk({ minY: -64, worldHeight: 384 });
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) chunk.setBlockStateId(new Vec3(x, 63, z), data.blocksByName.stone.defaultState);
    client.write('map_chunk', { x: 0, z: 0, heightmaps: nbt.comp({}), chunkData: chunk.dump(), blockEntities: [], skyLightMask: [], blockLightMask: [], emptySkyLightMask: [], emptyBlockLightMask: [], skyLight: [], blockLight: [] });
    client.write('position', { x: 8.5, y: 64, z: 8.5, pitch: 0, yaw: 0, flags: {}, teleportId: 1 });
    client.write('update_health', { health: 20, food: 20, foodSaturation: 5 });
    const slots = Array(46).fill(null); slots[9] = new Item(data.itemsByName.stone.id, 8);
    client.write('window_items', { windowId: 0, stateId: 1, items: slots.map(item => Item.toNotch(item)), carriedItem: Item.toNotch(null) });
    // Intentionally no window_click acknowledgement: uncertainty tests must keep
    // the backend's existing server-confirmation safety barrier latched.
  });
  return fixture;
}
function assertSameGame(fixture, initial, status) {
  assert.equal(fixture.connections, 1, 'Frontend lifecycle must never open a second game TCP connection');
  assert.equal(fixture.joins.length, 1, 'Frontend lifecycle must never log in a second player');
  assert.equal(fixture.ended, 0, 'Frontend lifecycle must not quit or disconnect the player');
  assert.equal(fixture.client, initial.gameClient, 'Same minecraft-protocol player object and TCP socket required');
  assert.equal(status.backend.pid, initial.backendPid, 'Same backend process required');
  assert.equal(status.sessionId, initial.sessionId, 'Same daemon session required');
  assert.equal(gameStatus(status).playerUuid, initial.uuid, 'Same Minecraft player identity required');
}
async function securityAndRace(startupOnly = false) {
  if (!startupOnly) {
  const dir = join(sandbox, 'security');
  const child = await daemon(dir);
  const observer = await peer(dir); await waitReady(observer);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'control.sock')).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'control.sock')).isSocket(), true);
  assert.equal(statSync(join(dir, 'control.sock')).uid, process.getuid());
  for (const ipcVersion of [undefined, 0, 2]) {
    const incompatible = await peer(dir);
    const rejected = await incompatible.request('attach', { ipcVersion });
    assert.equal(rejected.ok, false, 'Missing or incompatible IPC version must be rejected');
    assert.equal(rejected.error.code, 'PROTOCOL_MISMATCH'); incompatible.destroy();
  }
  const wrongSession = await peer(dir);
  const wrongTarget = await wrongSession.request('attach', { expectedSessionId: randomUUID(), frontendVersion: version });
  assert.equal(wrongTarget.ok, false, 'Controller must not attach to a different session than its readiness manifest');
  assert.equal(wrongTarget.error.code, 'SESSION_MISMATCH');
  assert.equal((await observer.okay('status')).controllerAttached, false, 'Wrong-target attach must not acquire control');
  wrongSession.destroy();
  const a = await peer(dir), b = await peer(dir);
  const results = await Promise.all([a.request('attach', { frontendVersion: version }), b.request('attach', { frontendVersion: version })]);
  assert.equal(results.filter(result => result.ok).length, 1, 'Concurrent attach must elect exactly one controller');
  const owner = results[0].ok ? a : b, other = owner === a ? b : a;
  assert.equal(results.find(result => !result.ok).error.code, 'CONTROLLER_BUSY');
  const unowned = await other.call('get-position'); assert.equal(unowned.ok, false, 'Unattached peer cannot call gameplay tools');
  const listed = await owner.okay('list'); assert.ok(listed.tools.length > 100);
  const status = await observer.okay('status');
  assert.equal(status.backend.server.version, version, 'Backend version must match the actual installed package');
  const duplicate = launch([join(root, 'runtime/minecraft-daemon.mjs'), '--offline-fixture', '--state-dir', dir]);
  assert.notEqual(await exited(duplicate), 0, 'Second daemon must reject active state directory');
  assert.equal((await observer.okay('status')).backend.pid, status.backend.pid);
  await owner.okay('detach');
  assert.equal((await owner.call('get-position')).ok, false, 'Detached controller cannot retain authority');
  await other.okay('attach', { frontendVersion: version });
  await other.okay('quit'); await exited(child);
  check('private socket, concurrent controller election, no dual control or daemon replacement');
  }
  for (const marker of ['daemon.lock', 'session.json', 'control.sock']) {
    const stale = join(sandbox, `stale-${marker.replace('.', '-')}`); mkdirSync(stale, { mode: 0o700 });
    writeFileSync(join(stale, marker), marker === 'session.json' ? '{"closed":true}' : '99999999', { mode: 0o600 });
    const rejected = launch([join(root, 'runtime/minecraft-daemon.mjs'), '--offline-fixture', '--state-dir', stale]);
    assert.notEqual(await exited(rejected), 0, `Stale ${marker} must not permit session restart or cleanup/takeover`);
    assert.ok(existsSync(join(stale, marker)), `Refusal must preserve stale ${marker} evidence`);
  }
  const real = join(sandbox, 'real-dir'); mkdirSync(real, { mode: 0o700 });
  const link = join(sandbox, 'linked-dir'); symlinkSync(real, link);
  const rejected = launch([join(root, 'runtime/minecraft-daemon.mjs'), '--offline-fixture', '--state-dir', link]);
  assert.notEqual(await exited(rejected), 0, 'Symlink state directory must be rejected');
  const publicDir = join(sandbox, 'public-dir'); mkdirSync(publicDir, { mode: 0o755 }); chmodSync(publicDir, 0o755);
  const publicRejected = launch([join(root, 'runtime/minecraft-daemon.mjs'), '--offline-fixture', '--state-dir', publicDir]);
  assert.notEqual(await exited(publicRejected), 0, 'Non-private state directory must be rejected rather than silently chmodded');
  assert.equal(statSync(publicDir).mode & 0o777, 0o755);
  const absent = join(sandbox, 'frontend-missing-daemon');
  const cannotStart = launch([join(root, 'runtime/minecraft-frontend.mjs'), '--attach', absent]);
  assert.notEqual(await exited(cannotStart), 0, 'Frontend must not create a missing daemon');
  assert.equal(existsSync(absent), false, 'Attach-only frontend must not create new session state');
  check('stale locks, old session markers, pre-existing socket paths, and symlink state directories fail closed');
  if (startupOnly) return;
  const deadDir = join(sandbox, 'dead-backend'); const deadDaemon = await daemon(deadDir);
  const deadObserver = await peer(deadDir); const before = await waitReady(deadObserver);
  const ownerAfterDeath = await peer(deadDir); await ownerAfterDeath.okay('attach', { frontendVersion: version });
  const inflight = ownerAfterDeath.call('move-in-direction', { direction: 'forward', duration: 4000 }, 'backend-death-action');
  await until(async () => (await deadObserver.okay('status')).activeRequest, 'backend action accepted');
  process.kill(before.backend.pid, 'SIGKILL');
  const lost = await inflight;
  assert.equal(lost.ok, false); assert.equal(lost.error.uncertain, true, 'Backend loss must report unresolved outcome honestly');
  await until(async () => (await deadObserver.okay('status')).backend.transportClosed, 'backend death observed');
  await ownerAfterDeath.okay('detach');
  const replacement = await peer(deadDir); await replacement.okay('attach', { frontendVersion: version });
  const retry = await replacement.call('move-in-direction', { direction: 'forward', duration: 4000 }, 'backend-death-action');
  assert.equal(retry.ok, false); assert.equal(retry.error.uncertain, true);
  await sleep(350);
  const after = await deadObserver.okay('status');
  assert.equal(after.backend.pid, before.backend.pid); assert.equal(after.backendEnded, true); assert.equal(after.uncertain, true);
  await replacement.okay('quit'); await exited(deadDaemon);
  check('backend death latches uncertainty, permits diagnosis, and never respawns or replays');
  const longDir = join(sandbox, 'long-' + 'x'.repeat(100)); const longDaemon = await daemon(longDir);
  const longManifest = JSON.parse(readFileSync(join(longDir, 'session.json'), 'utf8'));
  assert.ok(Buffer.byteLength(join(longDir, 'control.sock')) > 100);
  assert.match(longManifest.socketPath, new RegExp('^/tmp/minecraft-' + process.getuid() + '-[A-Za-z0-9]{6}/control\\.sock$'));
  assert.equal(statSync(dirname(longManifest.socketPath)).mode & 0o777, 0o700);
  assert.equal(statSync(longManifest.socketPath).mode & 0o777, 0o600);
  const longFrontend = await frontend(longDir);
  assert.notEqual((await longFrontend.client.callTool({ name: 'get-position', arguments: {} })).isError, true);
  await longFrontend.client.close();
  const longOwner = await peer(longDir); await waitDetached(longOwner); await longOwner.okay('attach', { frontendVersion: version });
  await longOwner.okay('quit'); await exited(longDaemon);
  assert.equal(existsSync(dirname(longManifest.socketPath)), false, 'Owned short socket directory must be cleaned on explicit quit');
  check('long state paths use a manifest-discovered private short Unix socket and clean it up on quit');
}
async function frontendCrashPersistence() {
  const fixture = await protocolFixture();
  const dir = join(sandbox, 'frontend-crash'); const child = await daemon(dir, fixture.port);
  const observer = await peer(dir); const ready = await waitReady(observer);
  const initial = { backendPid: ready.backend.pid, sessionId: ready.sessionId, uuid: gameStatus(ready).playerUuid, gameClient: fixture.client };
  assert.equal(fixture.joins[0].username, 'MCPBot'); assert.ok(initial.uuid);
  const raw = await peer(dir); await raw.okay('attach', { frontendVersion: version });
  const requestId = 'dedupe-chat-' + randomUUID();
  const first = await raw.call('send-chat', { message: 'offline synthetic dedupe check' }, requestId);
  assert.equal(first.ok, true); assert.notEqual(first.result.isError, true, toolText(first.result));
  const [again, third] = await Promise.all([raw.call('send-chat', { message: 'offline synthetic dedupe check' }, requestId), raw.call('send-chat', { message: 'offline synthetic dedupe check' }, requestId)]);
  assert.deepEqual(again.result, first.result); assert.deepEqual(third.result, first.result);
  const conflict = await raw.call('send-chat', { message: 'must never be sent' }, requestId);
  assert.equal(conflict.ok, false); assert.equal(conflict.error.code, 'REQUEST_ID_CONFLICT');
  assert.equal(gameStatus(await observer.okay('status')).chatSent, 1, 'Duplicate mutation must execute exactly once');
  await raw.okay('detach'); await waitDetached(observer);
  const firstFrontend = await frontend(dir);
  assert.equal(firstFrontend.client.getServerVersion().version, version, 'Frontend version must match installed package');
  const controller = await firstFrontend.client.callTool({ name: 'get-controller-status', arguments: {} });
  assert.ok(toolText(controller).includes(version), 'Frontend controller status must report version provenance');
  const before = gameStatus(await observer.okay('status')).position;
  const movingId = 'crash-movement-' + randomUUID();
  const moving = firstFrontend.client.callTool({ name: 'move-controls', arguments: { controls: { forward: true }, durationMs: 4000 }, _meta: { minecraftRequestId: movingId } });
  moving.catch(() => {});
  await until(async () => {
    const position = gameStatus(await observer.okay('status')).position;
    return Math.hypot(position.x - before.x, position.z - before.z) > 0.15;
  }, 'movement before controller crash');
  assert.ok(firstFrontend.transport.pid);
  process.kill(firstFrontend.transport.pid, 'SIGKILL');
  await waitDetached(observer);
  await sleep(700);
  const stopped = await observer.okay('status'); const stationary = gameStatus(stopped).position;
  assertSameGame(fixture, initial, stopped);
  await sleep(550);
  const later = await observer.okay('status'); const position = gameStatus(later).position;
  assert.ok(Math.hypot(position.x - stationary.x, position.z - stationary.z) < 0.05, 'Movement must stop promptly after frontend SIGKILL');
  const secondFrontend = await frontend(dir);
  assert.equal(secondFrontend.client.getServerVersion().version, version);
  const positionResult = await secondFrontend.client.callTool({ name: 'get-position', arguments: {} });
  assert.notEqual(positionResult.isError, true, toolText(positionResult));
  assertSameGame(fixture, initial, await observer.okay('status'));
  const replay = await secondFrontend.client.callTool({ name: 'move-controls', arguments: { controls: { forward: true }, durationMs: 4000 }, _meta: { minecraftRequestId: movingId } }).catch(error => ({ isError: true, error: String(error) }));
  assert.equal(replay.isError, true, 'Interrupted mutation must not be replayed as a fresh action');
  await sleep(400);
  const afterReplay = gameStatus(await observer.okay('status')).position;
  assert.ok(Math.hypot(afterReplay.x - position.x, afterReplay.z - position.z) < 0.05, 'Replay must not restart movement');
  await secondFrontend.client.close(); await waitDetached(observer);
  assertSameGame(fixture, initial, await observer.okay('status'));
  check('real MCP frontend SIGKILL and normal close preserve one backend, player UUID, and game socket; controls stop');
  check('request IDs deduplicate mutations, reject conflicts, and never replay interrupted movement');
  const emergency = await peer(dir); await emergency.okay('attach', { frontendVersion: version });
  const quitDuringAction = emergency.call('move-in-direction', { direction: 'forward', duration: 4000 }, 'quit-during-action'); quitDuringAction.catch(() => {});
  await until(async () => (await observer.okay('status')).activeRequest, 'action active before emergency quit');
  const quitAt = Date.now();
  await emergency.okay('quit');
  await until(() => fixture.ended === 1, 'explicit emergency quit disconnect', 2000); await exited(child);
  assert.ok(Date.now() - quitAt < 3000, 'Emergency quit must not wait for the four-second foreground action');
  assert.equal(fixture.connections, 1);
  check('explicit emergency quit is separate from detach and closes the game exactly once');
}
async function uncertaintyAndDisconnect() {
  const fixture = await protocolFixture();
  const dir = join(sandbox, 'uncertainty'); const child = await daemon(dir, fixture.port);
  const observer = await peer(dir); const ready = await waitReady(observer);
  const initial = { backendPid: ready.backend.pid, sessionId: ready.sessionId, uuid: gameStatus(ready).playerUuid, gameClient: fixture.client };
  const old = await peer(dir); await old.okay('attach', { frontendVersion: version });
  const requestId = 'unacknowledged-equipment-' + randomUUID();
  const args = { inventorySlot: 9, destination: 'hand', timeoutMs: 1200 };
  const unresolved = old.call('equip-inventory-slot', args, requestId, 'stale-response'); unresolved.catch(() => {});
  await until(() => fixture.packets.some(packet => packet.name === 'window_click'), 'real server equipment click');
  const beforeDetach = gameStatus(await observer.okay('status')).position;
  const packetsBeforeDetach = fixture.packets.length;
  old.destroy(); await waitDetached(observer);
  const next = await peer(dir); await next.okay('attach', { frontendVersion: version });
  const blocked = await next.call('move-controls', { controls: { forward: true }, durationMs: 100 }, randomUUID());
  // Cancellation may settle equipment before this new controller gets a turn.
  // Unresolved work rejects at IPC; settled cancellation rejects through the
  // backend inventory fence inside a successful IPC transport envelope. Neither
  // outcome permits the movement executor to run; arbitrary tool errors do not
  // count as evidence of the safety fence.
  if (blocked.ok === false) {
    assert.ok(['FENCED', 'ACTION_BUSY'].includes(blocked.error?.code), 'Unresolved detached work must reject at the daemon action gate');
  } else {
    assert.equal(blocked.ok, true);
    assert.equal(blocked.result?.isError, true, 'Settled cancellation must still reject the mutation');
    assert.match(toolText(blocked.result), /^Failed: Inventory safety lock:/, 'Backend rejection must preserve the equipment uncertainty fence');
  }
  const collision = await next.request('status', {}, 'stale-response');
  assert.equal(collision.ok, true); assert.equal(collision.result.sessionId, initial.sessionId);
  await until(async () => gameStatus(await observer.okay('status'))?.inventoryAuthority?.fence, 'backend inventory uncertainty fence');
  await sleep(150);
  assert.equal(next.messages.filter(message => message.id === 'stale-response').length, 1, 'Old controller response must not leak into new controller with colliding transport ID');
  const fenced = await observer.okay('status'); const fence = gameStatus(fenced).inventoryAuthority.fence;
  const afterDetach = gameStatus(fenced).position;
  assert.ok(Math.hypot(afterDetach.x - beforeDetach.x, afterDetach.z - beforeDetach.z) < 0.01, 'Rejected movement must not move the player');
  for (const { name, packet } of fixture.packets.slice(packetsBeforeDetach)) {
    if (name === 'position' || name === 'position_look') {
      assert.ok(Math.hypot(packet.x - beforeDetach.x, packet.z - beforeDetach.z) < 0.01, 'Rejected movement must not issue displaced game positions');
    }
  }
  assert.equal(fixture.packets.filter(packet => packet.name === 'window_click').length, 1, 'Cancellation must not issue another inventory click');
  assertSameGame(fixture, initial, fenced);
  const clicks = fixture.packets.filter(packet => packet.name === 'window_click').length;
  const duplicate = await next.call('equip-inventory-slot', args, requestId);
  assert.ok(duplicate.ok === false || duplicate.result?.isError === true, 'Unknown/failed equipment mutation must not be reported successful');
  assert.equal(fixture.packets.filter(packet => packet.name === 'window_click').length, clicks, 'Unresolved/failed mutation must never replay');
  await next.okay('detach'); await waitDetached(observer);
  const third = await peer(dir); await third.okay('attach', { frontendVersion: version });
  assert.equal(gameStatus(await observer.okay('status')).inventoryAuthority.fence, fence, 'Controller reattachment must preserve the existing backend inventory safety fence');
  await until(async () => {
    const status = await observer.okay('status');
    return !status.detachFence && !status.activeRequest && !gameStatus(status).controlFence;
  }, 'detach cleanup settled with the inventory fence retained');
  const settledMutation = await third.call('move-controls', { controls: { forward: true }, durationMs: 100 });
  assert.equal(settledMutation.ok, true, 'After cleanup, IPC must return the backend fence result');
  assert.equal(settledMutation.result?.isError, true, 'A cleared detach barrier must not clear the inventory fence');
  assert.match(toolText(settledMutation.result), /^Failed: Inventory safety lock:/);
  assert.equal(gameStatus(await observer.okay('status')).inventoryAuthority.fence, fence);
  const freshMutation = await third.call('equip-inventory-slot', args);
  assert.ok(freshMutation.ok === false || freshMutation.result?.isError === true);
  assert.equal(fixture.packets.filter(packet => packet.name === 'window_click').length, clicks);
  const stillFenced = gameStatus(await observer.okay('status'));
  assert.equal(stillFenced.inventoryAuthority.fence, fence);
  assert.ok(Math.hypot(stillFenced.position.x - beforeDetach.x, stillFenced.position.z - beforeDetach.z) < 0.01, 'Neither controller may move through the persistent inventory fence');
  check('detach fences unresolved mutation, isolates stale responses, preserves inventory safety lock, and forbids replay');
  fixture.client.end('synthetic real game disconnect');
  await until(async () => {
    const status = await observer.okay('status'); return status.backendEnded || gameStatus(status)?.ended;
  }, 'actual game disconnect observed');
  await third.request('detach');
  const afterEnd = await peer(dir);
  await afterEnd.request('attach', { frontendVersion: version });
  const afterEndCall = await afterEnd.call('get-position');
  assert.ok(afterEndCall.ok === false || afterEndCall.result?.isError === true, 'Ended game cannot report gameplay readiness');
  await sleep(2250);
  assert.equal(fixture.connections, 1, 'Status, attach, and tools after true disconnect must never reconnect');
  assert.equal(fixture.joins.length, 1);
  child.kill('SIGTERM'); await exited(child);
  const restart = launch([join(root, 'runtime/minecraft-daemon.mjs'), '--user-started-session', String(fixture.port), '--state-dir', dir]);
  assert.notEqual(await exited(restart), 0, 'Ended session directory must not be restarted');
  assert.equal(fixture.connections, 1);
  check('true game disconnect is terminal: attach/tool/status and old-directory restart cannot reconnect');
}
async function backendFixtureOnly() {
  // Useful on restricted runners that prohibit Unix listen(). This verifies
  // fixture/gameplay and stop-drain behavior only; it is NOT an IPC substitute
  // and cannot establish frontend crash survival or controller exclusivity.
  const fixture = await protocolFixture();
  const sessionId = randomUUID();
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'runtime/minecraft-server.mjs'), '--user-started-session', String(fixture.port), '--session-id', sessionId, '--state-dir', join(sandbox, 'direct-backend-state')], cwd: root, env, stderr: 'pipe' });
  let stderr = ''; transport.stderr.on('data', data => { stderr += data; });
  const client = new Client({ name: 'direct-backend-fixture-validator', version: '1.0.0' });
  frontends.add({ client, transport });
  await client.connect(transport, { timeout: 10000 });
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const status = async () => JSON.parse(toolText(await call('get-session-status')));
  await until(async () => (await status()).ready, 'direct backend ready: ' + stderr, 15000);
  const initial = await status();
  assert.equal(initial.backendSessionId, sessionId); assert.equal(initial.backendPid, transport.pid);
  assert.equal(initial.backendVersion, version); assert.ok(initial.playerUuid);
  const move = call('move-controls', { controls: { forward: true }, durationMs: 4000 }); move.catch(() => {});
  await until(async () => {
    const position = (await status()).position;
    return Math.hypot(position.x - initial.position.x, position.z - initial.position.z) > 0.15;
  }, 'direct backend real movement');
  // This second request must already be waiting in the backend's serial lane
  // when stop is dispatched. Cancellation of the first request must not allow
  // it to begin later while the stop barrier drains that lane.
  const beforeQueued = await status();
  const queued = call('move-controls', { controls: { right: true }, durationMs: 600 }); queued.catch(() => {});
  await sleep(30);
  const stopped = await call('stop-movement'); assert.notEqual(stopped.isError, true, toolText(stopped));
  assert.equal((await move).isError, true, 'Stop must cancel and drain active movement');
  const queuedResult = await queued;
  assert.equal(queuedResult.isError, true, 'Stop must reject movement already queued behind an active action before it executes');
  assert.match(toolText(queuedResult), /Safety stop.*fenced/, 'Queued request must fail because the active stop gate rejected it');
  const afterDrain = await status();
  assert.equal(afterDrain.controlFence, null, 'Successful stop must finish draining before its barrier clears');
  assert.ok(Math.abs(afterDrain.position.x - beforeQueued.position.x) < 0.01, 'Queued rightward controls must never execute while the stop barrier drains');
  await sleep(600); const settled = await status(); await sleep(400); const later = await status();
  assert.ok(Math.hypot(later.position.x - settled.position.x, later.position.z - settled.position.z) < 0.05);
  assert.equal(fixture.connections, 1); assert.equal(fixture.ended, 0);
  const equipment = await call('equip-inventory-slot', { inventorySlot: 9, destination: 'hand', timeoutMs: 150 });
  assert.equal(equipment.isError, true); assert.equal(fixture.packets.filter(packet => packet.name === 'window_click').length, 1);
  const fence = (await status()).inventoryAuthority.fence; assert.ok(fence);
  await call('stop-movement'); assert.equal((await status()).inventoryAuthority.fence, fence, 'Stopping must not clear an inventory fence');
  fixture.client.end('synthetic real disconnect');
  await until(async () => (await status()).ended, 'direct backend real disconnect');
  assert.equal((await call('get-position')).isError, true);
  await sleep(2250); assert.equal(fixture.connections, 1);
  check('direct real backend: queued movement rejected before execution, stop-and-drain, persistent inventory fence, terminal disconnect');
}

let failure;
const watchdog = setTimeout(() => {
  process.stderr.write('Daemon smoke watchdog expired\n');
  for (const child of children) child.kill('SIGKILL');
  process.exit(1);
}, 100000);
try {
  const only = process.argv[2];
  if (!only || only === 'security') await securityAndRace();
  if (!only || only === 'frontend') await frontendCrashPersistence();
  if (!only || only === 'uncertainty') await uncertaintyAndDisconnect();
  if (!only || only === 'backend') await backendFixtureOnly();
  if (only === 'paths') await securityAndRace(true);
  assert.ok(checks.length, 'Unknown smoke case');
} catch (error) { failure = error; process.stderr.write(`${error.stack}\n`); }
finally {
  for (const frontend of frontends) await frontend.client.close().catch(() => {});
  for (const item of peers) item.destroy();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await sleep(700);
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const fixture of fixtures) {
    for (const socket of fixture.sockets) socket.destroy();
    fixture.server.close();
  }
  clearTimeout(watchdog); rmSync(sandbox, { recursive: true, force: true });
}
const report = { passed: !failure, checks, target: 'loopback synthetic Minecraft 1.21.1 / protocol 767', actualMineflayer: require('mineflayer/package.json').version, expectedRuntimeVersion: version, verificationCase: process.argv[2] || 'all', fullControllerLifecycleVerified: !failure && !process.argv[2], liveServerUsed: false, credentialsUsed: false, ...(failure ? { error: failure.message } : {}) };
process.stdout.write(JSON.stringify(report, null, 2) + '\n', () => process.exit(failure ? 1 : 0));
