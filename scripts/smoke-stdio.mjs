#!/usr/bin/env node
// Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The release's default launch is deliberately disconnected. This script never
// sends --connect, never reads a deployment config, and never transmits credentials.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const expectedTools = [
  'can-craft', 'craft-item', 'detect-gamemode', 'dig-block', 'equip-item',
  'find-blocks', 'find-entity', 'find-item', 'fly-to', 'get-block-info',
  'get-position', 'get-recipe', 'jump', 'list-inventory', 'list-recipes',
  'look-at', 'move-in-direction', 'move-to-position', 'place-block',
  'read-chat', 'send-chat', 'smelt-item'
];
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(root, 'dist/main.js')],
  cwd: root,
  stderr: 'pipe',
  env: { PATH: process.env.PATH || '', HOME: '/tmp' }
});
let stderr = '';
transport.stderr?.on('data', data => { stderr += data.toString(); });
const client = new Client({ name: 'release-stdio-smoke', version: '1.0.0' });
const transportErrors = [];
client.onerror = error => { transportErrors.push(String(error)); };
const deadline = setTimeout(() => {
  process.stderr.write('Stdio smoke timed out\n');
  process.exitCode = 1;
  void client.close();
}, 15000);
try {
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.name, 'minecraft-mcp-server');
  assert.equal(client.getServerVersion()?.version, pkg.version);
  const { tools } = await client.listTools();
  const actualNames = tools.map(tool => tool.name);
  assert.equal(new Set(actualNames).size, actualNames.length);
  for (const name of expectedTools) assert.ok(actualNames.includes(name), `Missing ${name}`);
  const response = await client.callTool({ name: 'list-inventory', arguments: {} });
  assert.equal(response.isError, true);
  assert.match(JSON.stringify(response.content), /connect|offline|disconnected/i);
  assert.equal(transportErrors.length, 0, 'stdout must contain valid MCP messages only');
  const pid = transport.pid;
  await client.close();
  await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'child should stop after transport close');
  assert.doesNotMatch(stderr, /logged in successfully|spawned in world|ECONNREFUSED|ENOTFOUND|Attempting to reconnect/i);
  process.stdout.write(JSON.stringify({
    passed: true,
    server: 'minecraft-mcp-server',
    version: pkg.version,
    protocol: 'SDK initialize, tools/list, tools/call, transport close',
    toolCount: actualNames.length,
    legacyToolCount: expectedTools.length,
    liveServerUsed: false,
    credentialsUsed: false
  }, null, 2) + '\n');
} finally {
  clearTimeout(deadline);
  await client.close();
}
