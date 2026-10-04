#!/usr/bin/env node
// Execute the real frontend with an offline socket, SDK boundary and manual clock.
// No source rewriting, real sockets, game backend, credentials or wall-clock waits.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { IPC_VERSION, MAX_FRAME_BYTES, encodeFrame } from '../runtime/minecraft-ipc.mjs';

assert.equal(typeof vm.SourceTextModule, 'function', 'Run with node --experimental-vm-modules scripts/smoke-frontend-uncertainty.mjs');
const frontendUrl = new URL('../runtime/minecraft-frontend.mjs', import.meta.url);
const frontendSource = readFileSync(frontendUrl, 'utf8');
const callSchema = Symbol('CallToolRequestSchema'), listSchema = Symbol('ListToolsRequestSchema');
const session = { sessionId: '00000000-0000-4000-8000-000000000001', backendPid: 42, server: { version: 'fixture' } };
const attachment = { sessionId: session.sessionId, backend: { pid: session.backendPid, server: session.server } };
const successfulCall = { content: [{ type: 'text', text: 'synthetic success' }] };

async function flush() { for (let n = 0; n < 20; n++) await Promise.resolve(); }
async function settled(promise) {
  let result, failure, complete = false;
  promise.then(value => { result = value; complete = true; }, error => { failure = error; complete = true; });
  await flush();
  assert.equal(complete, true, 'Request must settle without waiting for a real timer');
  if (failure) throw failure;
  return result;
}

export async function createFrontendFixture() {
  const timers = new Map(), handlers = new Map();
  let nextTimer = 0, nextUuid = 0, connections = 0;
  const stderr = [], exits = [];
  const fakeProcess = Object.assign(new EventEmitter(), {
    stdin: new EventEmitter(), stderr: { write: text => stderr.push(text) }, exit: code => exits.push(code)
  });
  const clock = {
    setTimeout(callback, ms) {
      const timer = { id: ++nextTimer, callback, ms, unref() { return this; } };
      timers.set(timer.id, timer);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer?.id); },
    fire(ms) {
      const matches = [...timers.values()].filter(timer => timer.ms === ms);
      assert.ok(matches.length > 0, `Expected a pending ${ms} ms timer`);
      for (const timer of matches) {
        if (!timers.delete(timer.id)) continue;
        timer.callback();
      }
    }
  };
  class FakeSocket extends EventEmitter {
    destroyed = false;
    writes = [];
    writeError = null;
    write(frame) {
      assert.equal(this.destroyed, false, 'No writes after socket destruction');
      const request = JSON.parse(String(frame));
      this.writes.push(request); // A throwing write was still attempted.
      if (this.writeError) throw this.writeError;
      if (request.op === 'attach') queueMicrotask(() => this.reply(request, attachment));
      return true;
    }
    reply(request, result, error) {
      this.emit('data', Buffer.from(JSON.stringify(error ? { id: request.id, ok: false, error } : { id: request.id, ok: true, result }) + '\n'));
    }
    destroy(error) {
      if (this.destroyed) return this;
      this.destroyed = true;
      // Node sockets report an error before close. Both must be exercised.
      queueMicrotask(() => {
        if (error) this.emit('error', error);
        this.emit('close', Boolean(error));
      });
      return this;
    }
  }
  const socket = new FakeSocket();
  class FakeServer {
    setRequestHandler(schema, handler) { handlers.set(schema, handler); }
    async connect() {}
    async close() {}
  }
  const context = vm.createContext({ Buffer, console, process: fakeProcess, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  function synthetic(exports) {
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  }
  const imports = new Map([
    ['node:net', { default: { createConnection() { connections++; queueMicrotask(() => socket.emit('connect')); return socket; } } }],
    ['node:crypto', { randomUUID: () => `fixture-uuid-${++nextUuid}` }],
    ['node:util', { parseArgs: options => parseArgs({ ...options, args: ['--attach', '/offline-fixture'] }) }],
    ['@modelcontextprotocol/sdk/server/index.js', { Server: FakeServer }],
    ['@modelcontextprotocol/sdk/server/stdio.js', { StdioServerTransport: class {} }],
    ['@modelcontextprotocol/sdk/types.js', { CallToolRequestSchema: callSchema, ListToolsRequestSchema: listSchema }],
    ['./minecraft-ipc.mjs', { IPC_VERSION, MAX_FRAME_BYTES, encodeFrame, readDaemonSession: () => session, validateSocketPath: () => '/offline-fixture/control.sock' }]
  ]);
  const frontend = new vm.SourceTextModule(frontendSource, { context, identifier: frontendUrl.href });
  await frontend.link(specifier => {
    assert.ok(imports.has(specifier), `Unexpected frontend dependency: ${specifier}`);
    return synthetic(imports.get(specifier));
  });
  await frontend.evaluate();
  assert.deepEqual(stderr, [], 'Frontend must attach successfully to the offline fixture');
  assert.equal(handlers.has(callSchema), true);
  assert.equal(socket.writes.length, 1, 'Exactly one initial attach');
  return {
    socket, clock,
    signal(name) { fakeProcess.emit(name); },
    call(name = 'move-to', arguments_ = {}, meta) {
      return handlers.get(callSchema)({ params: { name, arguments: arguments_, ...(meta ? { _meta: meta } : {}) } });
    },
    requests(op) { return socket.writes.filter(request => request.op === op); },
    assertNoReplay(expectedCalls) {
      assert.equal(connections, 1, 'Transport failure must never reconnect');
      assert.equal(socket.writes.filter(request => request.op === 'call').length, expectedCalls, 'Each action is dispatched at most once');
    },
    async dispose() { socket.destroy(); await flush(); timers.clear(); }
  };
}

function errorResult(result, uncertain, message) {
  assert.equal(result.isError, true, message);
  assert.equal(result.content.length, 1);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.uncertain, uncertain, `${message}: uncertain`);
  assert.equal(body.automaticRetry, false, `${message}: automaticRetry`);
  return body;
}

const cases = [];
function test(name, run) { cases.push({ name, run }); }
const failures = [
  ['ECONNRESET', f => f.socket.destroy(Object.assign(Error('Synthetic connection reset'), { code: 'ECONNRESET' }))],
  ['invalid JSON frame', f => f.socket.emit('data', Buffer.from('{invalid\n'))],
  ['oversized unterminated frame', f => f.socket.emit('data', Buffer.alloc(MAX_FRAME_BYTES + 1, 120))],
  ['oversized terminated frame', f => f.socket.emit('data', Buffer.alloc(MAX_FRAME_BYTES + 2, 120).fill(10, MAX_FRAME_BYTES + 1))],
  ['clean close', f => f.socket.destroy()]
];
for (const [label, fail] of failures) {
  for (const statusFirst of [false, true]) {
    test(`${label}: concurrent call/status, ${statusFirst ? 'status' : 'call'} first`, async f => {
      let call, status;
      if (statusFirst) { status = f.call('get-controller-status'); call = f.call(); }
      else { call = f.call(); status = f.call('get-session-status'); }
      assert.equal(f.requests('call').length, 1);
      assert.equal(f.requests('status').length, 1);
      fail(f);
      const [callResult, statusResult] = await settled(Promise.all([call, status]));
      const callError = errorResult(callResult, true, 'Dispatched call transport loss');
      const statusError = errorResult(statusResult, false, 'Status is not a dispatched action');
      if (label === 'ECONNRESET') {
        assert.equal(callError.code, 'ECONNRESET');
        assert.equal(statusError.code, 'ECONNRESET');
      }
      // A closed connection is known before dispatching this new call.
      errorResult(await settled(f.call()), false, 'New call on closed connection');
      f.assertNoReplay(1);
    });
  }
}

test('write attempt throws, including another pending call and status', async f => {
  const earlierCall = f.call(), status = f.call('get-controller-status');
  f.socket.writeError = Object.assign(Error('Synthetic write failure'), { code: 'EPIPE' });
  const throwingCall = f.call();
  const [earlierResult, statusResult, throwingResult] = await settled(Promise.all([earlierCall, status, throwingCall]));
  assert.equal(errorResult(throwingResult, true, 'Throwing write is attempted dispatch').code, 'EPIPE');
  errorResult(earlierResult, true, 'Earlier dispatched call');
  errorResult(statusResult, false, 'Concurrent status');
  f.assertNoReplay(2);
});

test('explicit daemon rejection remains definite and preserves the code', async f => {
  const call = f.call();
  f.socket.reply(f.requests('call')[0], undefined, { message: 'Synthetic policy rejection', code: 'FIXTURE_REJECTED', uncertain: false });
  assert.equal(errorResult(await settled(call), false, 'Authoritative rejection').code, 'FIXTURE_REJECTED');
  f.assertNoReplay(1);
});

test('daemon rejection without uncertainty remains definite', async f => {
  const call = f.call();
  f.socket.reply(f.requests('call')[0], undefined, { message: 'Synthetic rejection' });
  errorResult(await settled(call), false, 'Authoritative rejection with no uncertainty flag');
  f.assertNoReplay(1);
});

test('explicit daemon uncertainty remains uncertain', async f => {
  const call = f.call();
  f.socket.reply(f.requests('call')[0], undefined, { message: 'Synthetic uncertain effect', uncertain: true });
  errorResult(await settled(call), true, 'Daemon uncertainty');
  f.assertNoReplay(1);
});

test('invalid request ID fails before dispatch', async f => {
  errorResult(await settled(f.call('move-to', {}, { minecraftRequestId: 'invalid space' })), false, 'Invalid argument');
  f.assertNoReplay(0);
});

for (const [label, makeArguments] of [
  ['BigInt', () => ({ value: 1n })],
  ['circular arguments', () => { const value = {}; value.self = value; return value; }],
  ['oversized outgoing frame', () => ({ value: 'x'.repeat(MAX_FRAME_BYTES) })]
]) {
  test(`${label} encoding fails before dispatch`, async f => {
    errorResult(await settled(f.call('move-to', makeArguments())), false, 'Failed encoding');
    f.assertNoReplay(0);
  });
}

test('call timeout is uncertain, closes other pending operations and ignores late success', async f => {
  const call = f.call(), status = f.call('get-controller-status');
  const request = f.requests('call')[0];
  f.clock.fire(185000);
  const [callResult, statusResult] = await settled(Promise.all([call, status]));
  errorResult(callResult, true, 'Timed out call');
  errorResult(statusResult, false, 'Status closed by call timeout');
  assert.equal(f.socket.destroyed, true, 'Timeout revokes the socket');
  f.socket.reply(request, successfulCall);
  await flush();
  assert.deepEqual(await settled(call), callResult, 'Late success cannot replace timeout');
  errorResult(await settled(f.call()), false, 'New call after timeout');
  f.assertNoReplay(1);
});

test('status timeout is definite while its concurrent call becomes uncertain', async f => {
  const status = f.call('get-controller-status'), call = f.call();
  f.clock.fire(10000);
  const [statusResult, callResult] = await settled(Promise.all([status, call]));
  errorResult(statusResult, false, 'Timed out status');
  errorResult(callResult, true, 'Call loses transport when status times out');
  f.assertNoReplay(1);
});

test('SIGTERM detaches once and classifies pending operations on close', async f => {
  const call = f.call(), status = f.call('get-controller-status');
  f.signal('SIGTERM');
  assert.equal(f.requests('detach').length, 1, 'Cancellation sends one detach');
  errorResult(await settled(f.call()), false, 'New call while closing is rejected before dispatch');
  f.socket.reply(f.requests('detach')[0], { detached: true });
  const [callResult, statusResult] = await settled(Promise.all([call, status]));
  errorResult(callResult, true, 'Dispatched call cancelled during shutdown');
  errorResult(statusResult, false, 'Status cancelled during shutdown');
  assert.equal(f.socket.destroyed, true, 'Detach acknowledgement closes the controller socket');
  f.signal('SIGTERM');
  assert.equal(f.requests('detach').length, 1, 'Repeated cancellation never replays detach');
  f.assertNoReplay(1);
});

test('unknown and duplicate responses never resolve another request', async f => {
  const first = f.call(), second = f.call();
  const [firstRequest, secondRequest] = f.requests('call');
  let secondComplete = false;
  second.then(() => { secondComplete = true; });
  f.socket.reply({ id: 'unknown-request' }, successfulCall);
  f.socket.reply(firstRequest, successfulCall);
  assert.deepEqual(JSON.parse(JSON.stringify(await settled(first))), successfulCall);
  f.socket.reply(firstRequest, { content: [{ type: 'text', text: 'late duplicate' }] });
  await flush();
  assert.equal(secondComplete, false, 'Unknown/duplicate response must not settle the other pending call');
  f.socket.reply(secondRequest, successfulCall);
  assert.deepEqual(JSON.parse(JSON.stringify(await settled(second))), successfulCall);
  f.assertNoReplay(2);
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let failed = 0;
  for (const { name, run } of cases) {
    let f;
    try {
      f = await createFrontendFixture();
      await run(f);
      console.log('PASS ' + name);
    } catch (error) {
      failed++;
      console.error('FAIL ' + name + ': ' + error.message);
    } finally { await f?.dispose(); }
  }
  console.log(JSON.stringify({ passed: failed === 0, cases: cases.length, failed, liveServerUsed: false, credentialsUsed: false, realSocketsUsed: false }));
  if (failed) process.exitCode = 1;
}
