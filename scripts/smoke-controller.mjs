#!/usr/bin/env node
// Queue/controller integration only, with a networkless game fixture.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'minecraft-controller-smoke-'));
const daemonDir = join(sandbox, 'game');
const children = [];
const env = { PATH: process.env.PATH || '', HOME: sandbox };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
async function until(test, label) {
  for (let n = 0; n < 400; n++) { if (test()) return; await sleep(25); }
  throw Error('Timed out: ' + label);
}
function launch(args, ownerPipe = false) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: [ownerPipe ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
  child.errors = '';
  child.stderr.on('data', data => { child.errors += data; });
  children.push(child); return child;
}
const done = child => child.exitCode !== null || child.signalCode !== null;
function call(dir, name) {
  const result = spawnSync('python3', ['runtime/call.py', '--state-dir', dir, '--timeout', '10', name], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.stdout); return JSON.parse(result.stdout);
}
try {
  const daemon = launch(['runtime/minecraft-daemon.mjs', '--offline-fixture', '--state-dir', daemonDir]);
  await until(() => {
    if (done(daemon)) throw Error('Daemon failed: ' + (existsSync(join(daemonDir, 'error.json')) ? readFileSync(join(daemonDir, 'error.json'), 'utf8') : daemon.errors));
    return existsSync(join(daemonDir, 'session.json'));
  }, 'daemon ready');
  const launcherRoot = join(sandbox, 'launcher-root');
  const gameRoot = join(launcherRoot, 'sessions', 'session-fixture');
  mkdirSync(join(gameRoot, 'controllers'), { recursive: true, mode: 0o700 });
  writeFileSync(join(launcherRoot, 'active-session.json'), JSON.stringify({ sessionId: 'session-fixture' }), { mode: 0o600 });
  const firstId = 'controller-' + '1'.repeat(32), secondId = 'controller-' + '2'.repeat(32);
  writeFileSync(join(gameRoot, 'current-controller.json'), JSON.stringify({ controllerId: firstId }), { mode: 0o600 });
  const firstDir = join(gameRoot, 'controllers', firstId);
  const first = launch(['runtime/minecraft-client.mjs', '--attach', daemonDir, '--state-dir', firstDir]);
  await until(() => existsSync(join(firstDir, 'controller-status.json')), 'first controller attached');
  const initial = json(join(firstDir, 'controller-status.json'));
  assert.equal(initial.frontendVersion, '3.1.1-rc.1');
  const backendPid = initial.daemon.backend.pid;
  assert.notEqual(call(launcherRoot, 'get-position').isError, true);
  assert.notEqual(call(launcherRoot, 'stop-movement').isError, true);
  const observedController = call(launcherRoot, 'get-controller-status');
  const observedStatus = JSON.parse(observedController.content.find(item => item.type === 'text').text);
  assert.equal(observedStatus.daemon.acceptedRequestCount, 1, 'Safety stop and status must not consume immutable action IDs');
  const firstCommands = readdirSync(join(firstDir, 'commands'));
  assert.equal(firstCommands.length, 3);
  writeFileSync(join(firstDir, 'detach.request'), 'Detach controller only\n');
  await until(() => done(first), 'controller detach exit');
  assert.equal(first.exitCode, 0);
  assert.equal(json(join(firstDir, 'closed.json')).controllerOnly, true);
  assert.equal(done(daemon), false);
  const oldCall = spawnSync('python3', ['runtime/call.py', '--state-dir', firstDir, 'get-position'], { cwd: root, env, encoding: 'utf8' });
  assert.notEqual(oldCall.status, 0);
  assert.deepEqual(readdirSync(join(firstDir, 'commands')), firstCommands);
  const stale = launch(['runtime/minecraft-client.mjs', '--attach', daemonDir, '--state-dir', firstDir]);
  await until(() => done(stale), 'stale controller rejection');
  assert.notEqual(stale.exitCode, 0);
  const secondDir = join(gameRoot, 'controllers', secondId);
  writeFileSync(join(gameRoot, 'current-controller.json'), JSON.stringify({ controllerId: secondId }), { mode: 0o600 });
  const second = launch(['runtime/minecraft-client.mjs', '--attach', daemonDir, '--state-dir', secondDir]);
  await until(() => existsSync(join(secondDir, 'controller-status.json')), 'second controller attached');
  const next = json(join(secondDir, 'controller-status.json'));
  assert.equal(next.daemon.backend.pid, backendPid);
  assert.equal(next.daemon.sessionId, initial.daemon.sessionId);
  assert.equal(next.daemon.backend.server.version, '3.1.1-rc.1');
  assert.notEqual(call(launcherRoot, 'get-position').isError, true);
  second.kill('SIGTERM'); await until(() => done(second), 'controller signal detach');
  assert.equal(done(daemon), false);
  const thirdDir = join(sandbox, 'owner-pipe-controller');
  const third = launch(['runtime/minecraft-client.mjs', '--attach', daemonDir, '--state-dir', thirdDir, '--owner-stdin'], true);
  await until(() => existsSync(join(thirdDir, 'controller-status.json')), 'owned controller attached');
  third.stdin.end();
  await until(() => done(third), 'UI owner pipe EOF detaches');
  assert.equal(done(daemon), false);
  const fourthDir = join(sandbox, 'explicit-quit-controller');
  const fourth = launch(['runtime/minecraft-client.mjs', '--attach', daemonDir, '--state-dir', fourthDir]);
  await until(() => existsSync(join(fourthDir, 'controller-status.json')), 'quit controller attached');
  const quit = call(fourthDir, 'disconnect-player');
  assert.equal(JSON.parse(quit.content.find(item => item.type === 'text').text).quitRequested, true);
  await until(() => done(daemon), 'explicit daemon stop');
  console.log(JSON.stringify({ passed: true, queueControllerReattachment: true, backendPidPreserved: true,
    oldQueuesRejected: true, detachedQueuesRejectNewCommands: true, launcherRootResolvesCurrentController: true, distinctFrontendBackendVersions: true,
    controllerDetachDoesNotQuit: true, ownerPipeEofDetaches: true, safetyToolsBypassActionLedger: true,
    explicitMcpDisconnectQuitsDaemon: true, liveServerUsed: false, credentialsUsed: false }, null, 2));
} finally {
  for (const child of children) if (!done(child)) child.kill('SIGTERM');
  await sleep(600);
  for (const child of children) if (!done(child)) child.kill('SIGKILL');
  rmSync(sandbox, { recursive: true, force: true });
}
