#!/usr/bin/env node
// Offline fake backend + private Unix IPC only. No Minecraft connection.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { validateSocketPath } from '../runtime/minecraft-ipc.mjs';

const dir = mkdtempSync(join(tmpdir(), 'defense-transport-'));
const child = spawn(process.execPath, ['runtime/minecraft-daemon.mjs', '--offline-fixture', '--state-dir', dir], { cwd: new URL('../', import.meta.url), env: { PATH: process.env.PATH, HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
let errors = '', socket, other;
child.stderr.on('data', chunk => { errors += chunk; }); child.stdout.resume();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { const end = Date.now() + 15000; while (Date.now() < end) { if (await fn()) return; if (child.exitCode !== null) throw Error(errors + (existsSync(join(dir, 'error.json')) ? readFileSync(join(dir, 'error.json'), 'utf8') : '')); await sleep(20); } throw Error('Fixture deadline exceeded: ' + errors); }
function peer(stream) {
  let data = '', id = 0; const pending = new Map();
  stream.setEncoding('utf8');
  stream.on('data', chunk => { data += chunk; for (;;) { const end = data.indexOf('\n'); if (end < 0) break; const item = JSON.parse(data.slice(0, end)); data = data.slice(end + 1); const done = pending.get(item.id); pending.delete(item.id); done?.(item); } });
  const request = (op, fields = {}) => new Promise(resolve => { const key = String(++id); pending.set(key, resolve); stream.write(JSON.stringify({ id: key, op, ...fields }) + '\n'); });
  return { request, call: (name, args = {}) => request('call', { name, arguments: args, requestId: randomUUID() }) };
}
const value = result => JSON.parse(result.result.content[0].text);
try {
  await until(() => existsSync(join(dir, 'session.json')));
  socket = net.createConnection(validateSocketPath(dir)); await once(socket, 'connect'); const owner = peer(socket);
  other = net.createConnection(validateSocketPath(dir)); await once(other, 'connect'); const stranger = peer(other);
  assert.equal((await stranger.call('self-defense-enable')).ok, false, 'Unattached peer cannot enable');
  assert.equal((await owner.request('attach', { ipcVersion: 1 })).ok, true);
  assert.equal(value(await owner.call('self-defense-status')).enabled, false);
  assert.equal(value(await owner.call('self-defense-enable')).enabled, true);
  let movingDone = false;
  const moving = owner.call('move-controls', { controls: { forward: true }, durationMs: 4000 }).then(v => { movingDone = true; return v; });
  await until(async () => (await owner.request('status')).result.activeRequest?.name === 'move-controls');
  assert.equal(value(await owner.call('self-defense-status')).enabled, true, 'Status available during a long foreground action');
  assert.equal((await owner.call('self-defense-enable')).error.code, 'ACTION_BUSY', 'Enable never bypasses the mutation lane');
  const disabled = owner.call('self-defense-disable');
  await until(async () => value(await owner.call('self-defense-status')).enabled === false);
  assert.equal(movingDone, false, 'Disable invalidates defense before unrelated movement drains');
  assert.equal((await owner.request('stop')).ok, true);
  assert.equal(value(await disabled).enabled, false);
  await moving;
  const status = (await owner.request('status')).result.backend.status;
  assert.equal(status.selfDefense.enabled, false);
  assert.equal((await owner.request('quit')).ok, true);
  await until(() => child.exitCode !== null);
  console.log(JSON.stringify({ passed: true, fixture: 'fake backend and private Unix IPC', defaultOff: true, controllerRequired: true, enableBusyGate: true, statusAndDisableDuringLongAction: true, stopWins: true, realMinecraftConnections: 0 }));
} finally {
  socket?.destroy(); other?.destroy();
  if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), sleep(5000)]); }
  rmSync(dir, { recursive: true, force: true });
}
