// Pure offline startup/argument acceptance. Fake bot over stdio only: no HTTP,
// game server, daemon Unix socket, real controller, sidecar or GUI is started.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import vm from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const decode = result => JSON.parse(result.content.find(part => part.type === 'text').text);
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw Error('World-file fixture did not reach its expected state');
}
async function fixture(extra, check, prepare = async () => {}) {
  const state = await mkdtemp(join(tmpdir(), 'world-file-backend-test-')); await prepare(state);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['runtime/minecraft-server.mjs', '--offline-fixture', '--state-dir', state, ...extra],
    env: { PATH: process.env.PATH }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'world-file-runtime-fixture', version: '1.0.0' });
  try {
    await client.connect(transport);
    const status = decode(await client.callTool({ name: 'get-session-status', arguments: {} }));
    await check(status, client, state);
  } finally { await client.close(); await rm(state, { recursive: true, force: true }); }
}

await fixture([], async (value, _client, state) => {
  assert.equal(value.worldObserver, null); assert.equal(value.observer, null);
  assert.equal(value.ready, true); assert.equal(existsSync(join(state, 'native-observer')), false);
});
await fixture(['--observe-world-files'], async (value, client, state) => {
  const directory = join(state, 'native-observer'), path = join(directory, 'world-frame.json');
  assert.deepEqual(value.worldObserver, { readonly: true, path }); assert.equal(value.observer, null);
  assert.equal((await stat(directory)).mode & 0o777, 0o700); assert.equal((await stat(path)).mode & 0o777, 0o600);
  const frame = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(frame.status, 'live'); assert.equal(frame.schemaVersion, 1); assert.equal(frame.minecraftVersion, '1.21.1');
  assert.equal(frame.volume.stateIds.length, 3757); assert.ok(frame.volume.stateIds.every(id => id === null), 'Fake unloaded blocks cannot become asserted air');
  assert.ok(frame.volume.biomes.every(id => id === null)); assert.equal(existsSync(join(directory, 'mesh-frame.json')), false);
  const quitting = await client.callTool({ name: 'disconnect-player', arguments: {} }); assert.equal(decode(quitting).disconnectRequested, true);
  await until(async () => JSON.parse(await readFile(path, 'utf8')).status === 'stale');
  const closed = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(closed.volume, null); assert.equal(closed.position, null); assert.equal(closed.reason, 'closed');
  assert.equal(decode(await client.callTool({ name: 'get-session-status', arguments: {} })).ended, true);
});
await fixture(['--observe-world-files'], async (value, client, state) => {
  assert.equal(value.ready, true); assert.equal(value.ended, false); assert.equal(value.inventoryAuthority.mutationReady, true);
  assert.deepEqual(value.worldObserver, { readonly: true, path: null, error: 'world_observer_start_failed' });
  assert.equal(await readFile(join(state, 'native-observer'), 'utf8'), 'not-a-directory');
  const again = decode(await client.callTool({ name: 'get-session-status', arguments: {} }));
  assert.equal(again.ready, true); assert.equal(again.worldObserver.error, 'world_observer_start_failed');
}, state => writeFile(join(state, 'native-observer'), 'not-a-directory', { mode: 0o600 }));

// Evaluate the exact checked-in parser and transport argument expression, not a
// copied implementation. The daemon body/imports are never evaluated or started.
const daemon = readFileSync('runtime/minecraft-daemon.mjs', 'utf8');
const parserLine = daemon.split('\n').find(line => line.startsWith('const { values } = parseArgs('));
const argsLine = daemon.split('\n').find(line => line.startsWith("  args: [join(runtimeDir, 'minecraft-server.mjs')"));
assert.ok(parserLine && argsLine, 'Daemon argument contract must remain inspectable');
const parse = args => vm.runInNewContext(`(()=>{${parserLine};return values;})()`, { args, parseArgs });
const backendArgs = values => Array.from(vm.runInNewContext(`(${argsLine.trim().slice('args: '.length).replace(/,$/, '')})`, {
  join, runtimeDir: '/fixture/runtime', mode: '--offline-fixture', fixture: true, port: null,
  sessionId: 'fixture-session', stateDir: '/fixture/state', observerPort: null, values,
}));
assert.equal(backendArgs(parse([])).includes('--observe-world-files'), false);
const explicit = backendArgs(parse(['--observe-world-files']));
assert.equal(explicit.filter(value => value === '--observe-world-files').length, 1);
assert.equal(explicit[explicit.indexOf('--state-dir') + 1], '/fixture/state/gameplay-state');
assert.equal(explicit.includes('--observe-port'), false);
assert.throws(() => parse(['--observe-world-files=/fixture/arbitrary']), { code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' });
assert.throws(() => parse(['--observe-world-files', '--world-output-path', '/fixture/arbitrary']), { code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' });
const backend = readFileSync('runtime/minecraft-server.mjs', 'utf8');
const backendParser = backend.split('\n').find(line => line.startsWith('const {values:backendOptions}=parseArgs('));
assert.ok(backendParser);
const parseBackend = args => vm.runInNewContext(`(()=>{${backendParser};return backendOptions;})()`, {
  fixture: true, process: { argv: ['node', 'fixture-backend', '--offline-fixture', ...args] }, parseArgs,
});
assert.equal(parseBackend([])['observe-world-files'], false);
assert.equal(parseBackend(['--observe-world-files'])['observe-world-files'], true);
assert.throws(() => parseBackend(['--observe-world-files=/fixture/arbitrary']), { code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' });
assert.throws(() => parseBackend(['--observe-world-files', '--world-output-path', '/fixture/arbitrary']), { code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' });
console.log(JSON.stringify({ passed: true, cases: ['disabled default creates no export', 'explicit private unloaded frame', 'quit clears without gameplay exit wait', 'export failure preserves backend', 'strict daemon boolean forwarding and fixed state root'], fixtureOnly: true, daemonStarted: false, gameSocketUsed: false }));
