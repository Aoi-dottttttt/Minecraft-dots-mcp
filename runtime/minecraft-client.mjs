// Modified for the public-candidate release; see RELEASE.md.
// Modified for 2.1.0-dot.2 release (2026-10-03). See RELEASE.md.
// Queue controller for a fresh frontend attachment; never reads credentials or reconnects.
// A controller may close or be replaced while its separately started daemon stays online.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { validateStateDir } from './minecraft-ipc.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
const argv = [...process.argv.slice(2)];
const mode = argv.shift();
if (!['--offline-fixture', '--attach'].includes(mode)) throw Error('Use --attach EXISTING_DAEMON_DIR; only explicit daemon startup can create a game session');
const fixture = mode === '--offline-fixture';
const daemonDir = fixture ? null : argv.shift();
if (!fixture && !daemonDir) throw Error('An existing private daemon directory is required');
const { values } = parseArgs({ args: argv, options: { 'state-dir': { type: 'string' }, 'owner-stdin': { type: 'boolean', default: false } }, strict: true });
if (!values['state-dir']) throw Error('A fresh private --state-dir is required');
process.umask(0o077);
const stateDir = resolve(values['state-dir']);
const runtimeDir = dirname(fileURLToPath(import.meta.url));
const privateDirectory = path => validateStateDir(path, { create: true });
privateDirectory(stateDir);
for (const name of ['commands', 'responses']) {
  const path = join(stateDir, name);
  privateDirectory(path);
  if (readdirSync(path).length) throw Error('Session queues must be empty; refusing to replay previous commands');
}
const lock = openSync(join(stateDir, 'client.lock'), 'wx', 0o600);
writeFileSync(lock, String(process.pid)); closeSync(lock);
const sessionId = stateDir.split('/').at(-1);
const save = (name, value) => {
  const path = join(stateDir, name), tmp = path + '.' + randomUUID() + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(tmp, path);
};
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'TZ'].includes(key)));
const transport = new StdioClientTransport({ command: process.execPath,
  args: fixture ? [join(runtimeDir, 'minecraft-server.mjs'), '--offline-fixture', '--state-dir', join(stateDir, 'gameplay-state')] : [join(runtimeDir, 'minecraft-frontend.mjs'), '--attach', resolve(daemonDir)],
  cwd: runtimeDir, env, stderr: 'pipe' });
transport.stderr?.on('data', () => {});
const client = new Client({ name: 'minecraft-private-session-client', version: '3.2.0-rc.3' });
let running = true, closing = false;
async function shutdown() {
  if (closing) return;
  closing = true; running = false;
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void shutdown(); });
if (values['owner-stdin']) {
  process.stdin.on('end', () => { void shutdown(); });
  process.stdin.on('error', () => { void shutdown(); });
  process.stdin.resume();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const call = (name, args = {}, requestId) => client.callTool({ name, arguments: args, ...(requestId ? { _meta: { minecraftRequestId: requestId } } : {}) }, undefined, { timeout: 190000 });
const parseStatus = result => {
  if (result.isError) throw Error('Session status unavailable');
  const text = result.content?.find(item => item.type === 'text')?.text;
  if (typeof text !== 'string') throw Error('Invalid status response');
  return JSON.parse(text);
};
let exitCode = 0;
try {
  if (closing) throw Error('Controller owner ended before attachment');
  await client.connect(transport, { timeout: 10000 });
  if (closing) {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    throw Error('Controller owner ended during attachment');
  }
  const listed = await client.listTools();
  const toolNames = new Set(listed.tools.map(tool => tool.name));
  save('tools.json', { server: client.getServerVersion(), tools: listed.tools });
  save('session.json', { sessionId, state: 'mcp_connected', at: new Date().toISOString(), pid: process.pid,
    server: client.getServerVersion(), frontendVersion: '3.2.0-rc.3', daemonDir, toolCount: listed.tools.length, automaticReconnect: false, controllerOnly: !fixture });
  if (!fixture) save('controller-status.json', parseStatus(await call('get-controller-status')));
  if (fixture) {
    const status = await call('get-session-status');
    const position = await call('get-position');
    const rejected = await call('send-chat', { message: '/op FixturePlayer' });
    save('fixture-result.json', { initialize: true, server: client.getServerVersion(), tools: listed.tools.length,
      status, position, slashChatRejected: rejected.isError === true, liveServerUsed: false });
    if (position.isError || !rejected.isError) throw Error('Offline fixture checks failed');
  } else {
    const seen = new Set();
    let lastStatus = 0, actionUncertain = false;
    while (running) {
      if (existsSync(join(stateDir, 'detach.request'))) break;
      if (existsSync(join(stateDir, 'stop.request'))) { await call('disconnect-player').catch(() => {}); break; }
      const files = readdirSync(join(stateDir, 'commands')).filter(name => /^\d{13}-[a-f0-9]{16}\.json$/.test(name) && !seen.has(name)).sort();
      if (files.length && !actionUncertain) {
        const id = files[0]; seen.add(id);
        let name, attempted = false;
        try {
          const path = join(stateDir, 'commands', id), stat = lstatSync(path);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw Error('Invalid command file');
          const command = JSON.parse(readFileSync(path, 'utf8'));
          name = command.name;
          if (command.sessionId !== sessionId || !toolNames.has(name)) throw Error('Wrong session or unknown tool');
          if (!Number.isFinite(command.createdAt) || Date.now() - command.createdAt > 120000 || command.createdAt - Date.now() > 5000) throw Error('Expired command; no replay');
          save('current-action.json', { id, state: 'executing', at: new Date().toISOString(), name });
          attempted = true;
          const result = await call(name, command.arguments ?? {}, sessionId + ':' + id);
          const uncertainResult = result.isError && result.content?.some(item => {
            if (item.type !== 'text') return false;
            try { return JSON.parse(item.text).uncertain === true; } catch { return false; }
          });
          if (uncertainResult) {
            actionUncertain = true;
            save('uncertain.json', { id, at: new Date().toISOString(), automaticRetry: false,
              message: 'Daemon action outcome is uncertain. No queued command will be replayed.' });
          }
          save('responses/' + id, { id, sessionId, at: new Date().toISOString(), name, result });
          save('current-action.json', { id, state: 'finished', at: new Date().toISOString(), name, isError: result.isError ?? false });
        } catch (error) {
          save('responses/' + id, { id, sessionId, at: new Date().toISOString(), name,
            error: String(error.message).slice(0, 240), uncertain: attempted, automaticRetry: false });
          save('current-action.json', { id, state: 'failed', at: new Date().toISOString(), name, automaticRetry: false });
          if (attempted) {
            actionUncertain = true;
            save('uncertain.json', { id, at: new Date().toISOString(), automaticRetry: false,
              message: 'MCP action outcome is uncertain. No further queued commands will execute in this session.' });
          }
        }
      }
      if (Date.now() - lastStatus > 2000) {
        lastStatus = Date.now();
        const status = parseStatus(await call('get-session-status'));
        save('status.json', status);
        if (status.ended) {
          save('session.json', { sessionId, state: 'disconnected', at: new Date().toISOString(), reconnectRequiresUserStart: true });
          break;
        }
      }
      await sleep(250);
    }
  }
} catch (error) {
  exitCode = 1;
  save('error.json', { at: new Date().toISOString(), message: String(error.message).slice(0, 240), automaticRetry: false });
} finally {
  await shutdown();
  save('closed.json', { sessionId, at: new Date().toISOString(), closed: true, exitCode, controllerOnly: !fixture,
    gameDisconnectedByControllerClose: false, automaticRetry: false });
  process.exitCode = exitCode;
}
