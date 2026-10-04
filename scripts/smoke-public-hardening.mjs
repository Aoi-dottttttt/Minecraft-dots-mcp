#!/usr/bin/env node
// Public-candidate regression checks; synthetic data, no game connection.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'minecraft-public-check-'));
const env = { PATH: process.env.PATH || '', HOME: sandbox };
const run = args => spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 15000 });
let client;
try {
  const publicDir = join(sandbox, 'public-state'); mkdirSync(publicDir, { mode: 0o755 }); chmodSync(publicDir, 0o755);
  const insecure = run(['runtime/minecraft-client.mjs', '--offline-fixture', '--state-dir', publicDir]);
  assert.notEqual(insecure.status, 0); assert.match(insecure.stderr, /private \(0700\)/);
  const target = join(sandbox, 'real-parent'); mkdirSync(target, { mode: 0o700 });
  const link = join(sandbox, 'linked-parent'); symlinkSync(target, link);
  const linked = run(['runtime/minecraft-client.mjs', '--offline-fixture', '--state-dir', join(link, 'child')]);
  assert.notEqual(linked.status, 0); assert.match(linked.stderr, /not symlinks/);
  const invalid = run(['runtime/minecraft-daemon.mjs', '--offline-fixture', '--username', 'invalid/name', '--state-dir', join(sandbox, 'invalid')]);
  assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /Username must/);
  const directory = join(sandbox, 'fresh-controller'); mkdirSync(directory, { mode: 0o700 });
  const victim = join(sandbox, 'untouched.txt'); writeFileSync(victim, 'unchanged');
  symlinkSync(victim, join(directory, 'tools.json.tmp'));
  const safeWrite = run(['runtime/minecraft-client.mjs', '--offline-fixture', '--state-dir', directory]);
  assert.equal(safeWrite.status, 0, safeWrite.stderr); assert.equal(readFileSync(victim, 'utf8'), 'unchanged');
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['runtime/minecraft-server.mjs', '--offline-fixture', '--username', 'FixtureBot', '--state-dir', join(sandbox, 'backend')], cwd: root, env, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  client = new Client({ name: 'public-hardening-check', version: '1.0.0' });
  await client.connect(transport);
  const catalog = await client.listTools();
  for (const name of ['register_chat_pattern', 'wait_for_message', 'send_packet', 'run_command']) {
    assert.ok(!catalog.tools.some(tool => tool.name === name), `Unsafe tool present: ${name}`);
  }
  const response = await client.callTool({ name: 'get-session-status', arguments: {} });
  assert.equal(JSON.parse(response.content.find(item => item.type === 'text').text).username, 'FixtureBot');
  if (process.argv.includes('--write-catalog')) writeFileSync(join(root, 'CAPABILITIES.json'), JSON.stringify({ server: client.getServerVersion(), tools: catalog.tools }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, privateStateRequired: true, symlinkAncestorRejected: true, predictableTemporarySymlinkUntouched: true, configurableIdentity: true, regexToolsAbsent: true, toolCount: catalog.tools.length, liveServerUsed: false }));
} finally {
  await client?.close();
  rmSync(sandbox, { recursive: true, force: true });
}
