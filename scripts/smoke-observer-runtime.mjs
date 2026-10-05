import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function fixture(extra, check) {
  const state = await mkdtemp(join(tmpdir(), 'observer-fixture-'));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['runtime/minecraft-server.mjs', '--offline-fixture', '--state-dir', state, ...extra],
    env: { PATH: process.env.PATH }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'observer-runtime-fixture', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'get-session-status', arguments: {} });
    await check(JSON.parse(result.content.find(part => part.type === 'text').text), client);
  } finally { await client.close(); await rm(state, { recursive: true, force: true }); }
}
await fixture([], async value => { assert.equal(value.observer, null); assert.equal(value.ready, true); });
await fixture(['--observe-port', '0'], async (value, client) => {
  assert.equal(value.observer.readonly, true); assert.match(value.observer.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const response = await fetch(value.observer.url + 'api/snapshot'); assert.equal(response.status, 200);
  const snapshot = await response.json(); assert.equal(snapshot.readonly, true); assert.equal(snapshot.inventory.ready, true);
  assert.equal(snapshot.inventory.slots.length, 46);
  await client.callTool({ name: 'disconnect-player', arguments: {} });
  await assert.rejects(fetch(value.observer.url));
});
const occupied = createServer(); occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening');
try {
  await fixture(['--observe-port', String(occupied.address().port)], async value => {
    assert.equal(value.ready, true); assert.equal(value.ended, false);
    assert.deepEqual(value.observer, { url: null, readonly: true, error: 'observer_start_failed' });
  });
} finally { await new Promise(resolve => occupied.close(resolve)); }
console.log(JSON.stringify({ passed: true, cases: ['disabled default', 'explicit loopback startup/shutdown', 'occupied port preserves backend'], fixtureOnly: true, liveServerUsed: false }));
