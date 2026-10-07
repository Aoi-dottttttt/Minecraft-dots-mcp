#!/usr/bin/env node
// Runs the unchanged broker call function in a VM with fake transport/state.
// No Unix/TCP socket, real backend, Minecraft server or network is used.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
const source = readFileSync(new URL('../runtime/minecraft-daemon.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function call(socket, request) {');
const end = source.indexOf('\nasync function dispatch(', start);
assert.ok(start > 0 && end > start);
const owner = {}, calls = [];
const c = vm.createContext({
  requireController: socket => { if (socket !== owner) throw Object.assign(Error('not attached'), { code: 'NOT_CONTROLLER' }); },
  validateCall: r => r.arguments ?? {}, createHash, stableJson: JSON.stringify, ledger: new Map(), ledgerBytes: 0,
  MAX_REQUESTS: 100, MAX_LEDGER_BYTES: 10000000, MAX_FRAME_BYTES: 1024,
  backendTransportClosed: false, backendEnded: false, detachFence: false, uncertain: false, safetyStop: false, activeCall: { name: 'move-controls' },
  fail: (code, message, extra) => Object.assign(Error(message), { code, ...extra }), persistStatus() {},
  rawCall: async (name) => { calls.push(name); return { content: [{ type: 'text', text: '{"enabled":false}' }] }; },
  parseBackendStatus: r => JSON.parse(r.content[0].text), markBackendEnded() {}, refreshStatus: async () => {}, markUncertain() {},
  errorValue: e => ({ code: e.code, message: e.message, uncertain: e.uncertain }), Buffer,
});
vm.runInContext(source.slice(start, end) + '\nthis.testCall=call;', c);
const request = name => ({ name, arguments: {}, requestId: randomUUID() });
for (const name of ['self-defense-enable', 'self-defense-disable', 'self-defense-status']) await assert.rejects(c.testCall({}, request(name)), { code: 'NOT_CONTROLLER' });
await assert.rejects(c.testCall(owner, request('self-defense-enable')), { code: 'ACTION_BUSY' });
await c.testCall(owner, request('self-defense-status'));
await c.testCall(owner, request('self-defense-disable'));
assert.equal(c.activeCall.name, 'move-controls');
c.uncertain = true;
await c.testCall(owner, request('self-defense-status'));
await c.testCall(owner, request('self-defense-disable'));
await assert.rejects(c.testCall(owner, request('self-defense-enable')), { code: 'FENCED' });
assert.equal(c.uncertain, true, 'Disable cannot clear an existing fence');
c.uncertain = false; c.activeCall = null;
const enable = request('self-defense-enable'); await c.testCall(owner, enable); await c.testCall(owner, enable);
assert.equal(calls.filter(n => n === 'self-defense-enable').length, 1, 'Accepted request id is never replayed');
c.backendEnded = true;
await assert.rejects(c.testCall(owner, request('self-defense-enable')), { code: 'BACKEND_ENDED' });
await c.testCall(owner, request('self-defense-status'));
console.log(JSON.stringify({ passed: true, fixture: 'unchanged daemon call function with fake VM transport', checks: 11, realIpcValidated: false, networkConnections: 0 }));
