#!/usr/bin/env node
// Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
// Offline native-adapter checks. No launcher click, bridge process, or credential.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'minecraft-runtime-smoke-'));
const session = join(sandbox, 'session-fixture');
const run = (command, args) => spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH || '', HOME: sandbox } });
const expected = [
  'can-craft', 'craft-item', 'detect-gamemode', 'dig-block', 'equip-item',
  'find-blocks', 'find-entity', 'find-item', 'get-block-info', 'get-position',
  'get-recipe', 'jump', 'list-inventory', 'list-recipes', 'look-at', 'move-in-direction',
  'move-to-position', 'place-block', 'read-chat', 'send-chat', 'smelt-item',
  'get-session-status', 'inspect-nearby', 'consume-food', 'attack-mob',
  'stop-movement', 'respawn-player', 'disconnect-player'
].sort();
try {
  const result = run(process.execPath, ['runtime/minecraft-client.mjs', '--offline-fixture', '--state-dir', session]);
  assert.equal(result.status, 0, result.stderr || 'Runtime fixture should exit successfully');
  const report = JSON.parse(readFileSync(join(session, 'fixture-result.json'), 'utf8'));
  const tools = JSON.parse(readFileSync(join(session, 'tools.json'), 'utf8'));
  assert.equal(report.initialize, true);
  assert.equal(report.slashChatRejected, true);
  assert.equal(report.liveServerUsed, false);
  assert.notEqual(report.position.isError, true);
  const names = tools.tools.map(tool => tool.name);
  for (const name of expected) assert.ok(names.includes(name), `Missing legacy tool ${name}`);
  assert.equal(new Set(names).size, names.length, 'Duplicate MCP names');
  for (const name of ['activate_block','open_container','container_deposit','sleep','fish','trade_with_villager','enchant_item','anvil_combine','mount_entity','activate_item','inspect-block-properties','open-workstation','select-window-option','equip-inventory-slot','read-book']) assert.ok(names.includes(name), `Missing gameplay tool ${name}`);
  for (const name of ['send_packet','run_command','connect_bot','reconnect_bot','creative_fly','set_physics_enabled']) assert.ok(!names.includes(name), `Forbidden tool ${name}`);
  assert.ok(names.length > 100);
  console.log(`Integrated tool count: ${names.length}`);
  assert.equal(statSync(session).mode & 0o777, 0o700);
  assert.equal(readdirSync(join(session, 'commands')).length, 0);
  assert.equal(JSON.parse(readFileSync(join(session, 'closed.json'), 'utf8')).closed, true);
  const reuse = run(process.execPath, ['runtime/minecraft-client.mjs', '--offline-fixture', '--state-dir', session]);
  assert.notEqual(reuse.status, 0, 'An old session must never restart');
  const stale = join(sandbox, 'session-stale');
  mkdirSync(join(stale, 'commands'), { recursive: true, mode: 0o700 });
  writeFileSync(join(stale, 'commands', 'old.json'), '{}');
  const replay = run(process.execPath, ['runtime/minecraft-client.mjs', '--offline-fixture', '--state-dir', stale]);
  assert.notEqual(replay.status, 0, 'Old commands must block startup before transport creation');
  assert.match(replay.stderr, /refusing to replay previous commands/);
  const closedCall = run('python3', ['runtime/call.py', '--state-dir', session, 'get-position']);
  assert.notEqual(closedCall.status, 0);
  assert.equal(readdirSync(join(session, 'commands')).length, 0, 'Closed session cannot receive commands');
  const bridge = join(sandbox, 'unexecuted-bridge.cjs');
  writeFileSync(bridge, 'throw Error("Bridge must not execute in launcher check");\n');
  const check = run('python3', ['runtime/launch-ui.py', '--config', join(sandbox, 'absent-config.json'), '--bridge', bridge, '--node', process.execPath, '--check']);
  assert.equal(check.status, 0, check.stderr);
  const checked = JSON.parse(check.stdout);
  assert.equal(checked.credentialsRead, false);
  assert.equal(checked.networkStarted, false);
  assert.equal(checked.userStartRequired, true);
  assert.equal(checked.runtimeFilesPresent, true);
  console.log(JSON.stringify({ passed: true, nativeToolCount: tools.tools.length, legacyToolCount: expected.length, sdkTransport: 'stdio',
    freshSessionRequired: true, staleCommandsRejected: true, closedSessionRejected: true,
    launcherRequiresUserClick: true, liveServerUsed: false, credentialsUsed: false }, null, 2));
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
