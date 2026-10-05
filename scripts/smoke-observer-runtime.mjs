import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const state = await mkdtemp(join(tmpdir(), 'observer-fixture-'));
const transport = new StdioClientTransport({ command: process.execPath,
  args: ['runtime/minecraft-server.mjs', '--offline-fixture', '--state-dir', state, '--observe-port', '0'],
  env: { PATH: process.env.PATH }, stderr: 'pipe' });
transport.stderr?.on('data', () => {});
const client = new Client({ name: 'observer-runtime-fixture', version: '1.0.0' });
try {
  await client.connect(transport);
  const result = await client.callTool({ name: 'get-session-status', arguments: {} });
  const value = JSON.parse(result.content.find(part => part.type === 'text').text);
  assert.equal(value.observer.readonly, true); assert.match(value.observer.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const response = await fetch(value.observer.url + 'api/snapshot'); assert.equal(response.status, 200);
  const snapshot = await response.json(); assert.equal(snapshot.readonly, true); assert.equal(snapshot.inventory.ready, true);
  assert.equal(snapshot.inventory.slots.length, 46);
  await client.callTool({ name: 'disconnect-player', arguments: {} });
  await assert.rejects(fetch(value.observer.url));
  console.log(JSON.stringify({ passed: true, observer: 'explicit loopback startup and shutdown', fixtureOnly: true, liveServerUsed: false }));
} finally { await client.close(); await rm(state, { recursive: true, force: true }); }
