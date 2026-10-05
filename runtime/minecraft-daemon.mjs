#!/usr/bin/env node
// Modified for the public-candidate release; see RELEASE.md.
// One explicit game lifetime. Restartable frontends never own backend stdio.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, lstatSync, openSync, readdirSync, renameSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { IPC_VERSION, MAX_FRAME_BYTES, SOCKET_NAME, encodeFrame, stableJson, validateStateDir } from './minecraft-ipc.mjs';

const DAEMON_VERSION = '3.1.1-rc.2';
const CALL_TIMEOUT_MS = 180000;
const MAX_LEDGER_BYTES = 16 * MAX_FRAME_BYTES;
const MAX_PEER_REQUESTS = 8, MAX_GLOBAL_REQUESTS = 32;
const MAX_REQUESTS = 10000; // Retain every accepted ID for the entire session; never evict/replay.
const args = [...process.argv.slice(2)];
const mode = args.shift();
if (!['--offline-fixture', '--user-started-session'].includes(mode)) throw Error('Explicit user-started session or offline fixture mode required');
const fixture = mode === '--offline-fixture';
const port = fixture ? null : Number(args.shift());
if (!fixture && (!Number.isInteger(port) || port < 1024 || port > 65535)) throw Error('Valid explicitly started loopback bridge port required');
const { values } = parseArgs({ args, options: { 'state-dir': { type: 'string' }, 'username': { type: 'string', default: 'MCPBot' } }, strict: true });
if (!/^[A-Za-z0-9_]{1,16}$/.test(values.username)) throw Error('Username must be 1..16 letters, digits or underscores');
process.umask(0o077);
const stateDir = validateStateDir(values['state-dir'], { create: true });
if (readdirSync(stateDir).length) throw Error('Fresh daemon state directory required; refusing previous session or command replay');
const lock = openSync(join(stateDir, 'daemon.lock'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
writeFileSync(lock, String(process.pid));
closeSync(lock);
// Linux sockaddr_un has a short path limit. Long arbitrary state roots keep
// their private durable records, with only the endpoint in a fresh short /tmp
// directory. This is still a private Unix socket, never a TCP fallback.
let socketDirectory = stateDir, temporarySocketIdentity = null, boundSocketIdentity = null;
if (Buffer.byteLength(join(stateDir, SOCKET_NAME)) > 100) {
  socketDirectory = mkdtempSync('/tmp/minecraft-' + process.getuid() + '-');
  validateStateDir(socketDirectory);
  temporarySocketIdentity = lstatSync(socketDirectory);
}
const socketPath = join(socketDirectory, SOCKET_NAME);
const sessionId = randomUUID();
const startedAt = new Date().toISOString();
const runtimeDir = dirname(fileURLToPath(import.meta.url));
const save = (name, value) => {
  const target = join(stateDir, name), temp = target + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temp, target);
};
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'TZ'].includes(key)));
const transport = new StdioClientTransport({ command: process.execPath,
  args: [join(runtimeDir, 'minecraft-server.mjs'), mode, ...(fixture ? [] : [String(port)]), '--session-id', sessionId, '--username', values.username, '--state-dir', join(stateDir, 'gameplay-state')],
  cwd: runtimeDir, env, stderr: 'pipe' });
// Drain stderr so a full pipe cannot hang gameplay. Do not copy potentially
// sensitive game text, bridge data, or arbitrary protocol data into diagnostics.
transport.stderr?.on('data', () => {});
const client = new Client({ name: 'minecraft-persistent-game-daemon', version: DAEMON_VERSION });
const sockets = new Set();
const ledger = new Map();
let catalog = { tools: [] }, toolNames = new Set(), backendServer = null, backendPid = null, backendStatus = null;
let controller = null, activeCall = null, detachFence = false, uncertain = false, uncertaintyReason = null;
let closing = false, closed = false, backendEnded = false, backendTransportClosed = false, endReason = null;
let cleanup = Promise.resolve(), pollTimer, stopTimer, pollBusy = false, statusRefresh = null;
let ledgerBytes = 0, outstandingRequests = 0, uncertaintyStop = null, safetyStop = null;
const server = createServer();
const fail = (code, message, extra = {}) => Object.assign(Error(message), { code, ...extra });
const errorValue = error => ({ code: typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR',
  message: String(error.message || error).slice(0, 400), ...(error.uncertain ? { uncertain: true } : {}), automaticRetry: false });
function markUncertain(reason) {
  uncertain = true;
  uncertaintyReason ??= reason;
  persistStatus();
  // Failure never retries the failed action. One independent safety stop is
  // allowed, without clearing this permanent uncertainty latch on success.
  if (!uncertaintyStop && !backendTransportClosed && !closing && backendPid) {
    uncertaintyStop = rawCall('stop-movement').catch(() => {});
  }
}
function snapshot() {
  return { protocolVersion: IPC_VERSION, sessionId, daemonVersion: DAEMON_VERSION, daemonPid: process.pid,
    startedAt, at: new Date().toISOString(), mode: fixture ? 'offline-fixture' : 'user-started-session',
    state: closed ? 'closed' : closing ? 'closing' : backendEnded ? 'backend_ended' : uncertain ? 'uncertain' : detachFence ? 'detaching' : 'ready',
    backend: { sessionId, pid: backendPid, server: backendServer, status: backendStatus, transportClosed: backendTransportClosed },
    ready: Boolean(backendStatus?.ready && !backendEnded && !closing), ended: backendEnded,
    controllerAttached: controller !== null, canMutate: Boolean(controller && backendStatus?.ready && !backendEnded && !closing && !detachFence && !uncertain && !activeCall && !safetyStop && !backendStatus?.controlFence && backendStatus?.inventoryAuthority?.mutationReady === true && !backendStatus?.inventoryAuthority?.fence && !backendStatus?.inventoryAuthority?.cursor), controllerId: controller?.controllerId ?? null,
    frontendVersion: controller?.frontendVersion ?? null, detachFence, uncertain, uncertaintyReason,
    backendEnded, endReason, activeRequest: activeCall ? { requestId: activeCall.requestId, name: activeCall.name } : null,
    acceptedRequestCount: ledger.size, automaticReconnect: false, automaticRetry: false,
    backendUpdatesRequireSessionRestart: true };
}
function persistStatus() { try { save('status.json', snapshot()); } catch { /* IPC memory remains authoritative; diagnostic failure cannot clear fences. */ } }
function markBackendEnded(reason, transportClosed = false) {
  backendEnded = true;
  backendTransportClosed ||= transportClosed;
  endReason ??= reason;
  if (backendStatus) backendStatus = { ...backendStatus, ready: false, ended: true };
  if (activeCall) markUncertain('Backend ended while an action outcome was unresolved');
  persistStatus();
}
client.onclose = () => { if (!closed) markBackendEnded('backend_stdio_closed', true); };
client.onerror = () => { if (!closing) markUncertain('Backend MCP transport error; no automatic recovery'); };
const rawCall = (name, parameters = {}, timeout = CALL_TIMEOUT_MS) => client.callTool({ name, arguments: parameters }, undefined, { timeout });
function parseBackendStatus(result) {
  if (result.isError) throw Error('Backend status returned an error');
  const text = result.content?.find(part => part.type === 'text')?.text;
  if (typeof text !== 'string') throw Error('Backend status is unavailable');
  const value = JSON.parse(text);
  if (value.backendSessionId !== sessionId || value.backendPid !== backendPid || value.backendVersion !== backendServer?.version) {
    throw Error('Backend session identity mismatch');
  }
  return value;
}
function refreshStatus() {
  if (closing || backendTransportClosed) return Promise.resolve();
  // Observers and the background poll share one read, never an unbounded queue.
  statusRefresh ??= (async () => {
    const value = parseBackendStatus(await rawCall('get-session-status', {}, 10000));
    backendStatus = value;
    if (value.ended) markBackendEnded(value.endReason || 'game_session_ended');
    persistStatus();
  })().finally(() => { statusRefresh = null; });
  return statusRefresh;
}
function send(socket, value) {
  if (socket.destroyed || !socket.writable) return;
  try {
    // Bound output buffering too; slow readers cannot accumulate tool responses.
    const frame = encodeFrame(value);
    if (socket.writableLength + Buffer.byteLength(frame) > 2 * MAX_FRAME_BYTES) { socket.destroy(); return; }
    socket.write(frame);
  } catch { socket.destroy(); }
}
function requireController(socket) {
  if (closing) throw fail('SHUTTING_DOWN', 'Game session is shutting down');
  if (controller?.socket !== socket) throw fail('NOT_CONTROLLER', 'Attach this frontend before issuing a game action');
}
async function detach(socket) {
  if (controller?.socket !== socket) return { detached: true, ...snapshot() };
  controller = null; // Revoke synchronously, before any asynchronous cleanup.
  if (detachFence) return { detached: true, ...snapshot() }; // Coalesce attach/detach storms.
  detachFence = true;
  const oldAction = activeCall?.settled;
  persistStatus();
  const stop = async () => {
    if (backendTransportClosed || closing) return;
    const result = await rawCall('stop-movement');
    if (result.isError) throw Error('Backend could not safely stop and drain active work');
    backendStatus = parseBackendStatus(result);
  };
  // Send cancellation now, outside the foreground action lane. Never close
  // backend stdio here. A stop acknowledgement itself drains the backend lane.
  const immediateStop = stop();
  const previousCleanup = cleanup;
  cleanup = (async () => {
    try {
      await Promise.all([previousCleanup, immediateStop, oldAction]);
      // An old executor may have raced cancellation or restored held controls.
      await stop();
    } catch { markUncertain('Controller detach cleanup was not confirmed; session remains fenced'); }
    finally { detachFence = false; persistStatus(); }
  })();
  return { detached: true, ...snapshot() };
}
function validateCall(request) {
  if (typeof request.requestId !== 'string' || !/^[A-Za-z0-9_.:/-]{1,160}$/.test(request.requestId)) throw fail('INVALID_REQUEST_ID', 'A unique bounded requestId is required');
  if (typeof request.name !== 'string' || !toolNames.has(request.name)) throw fail('UNKNOWN_TOOL', 'Unknown backend tool');
  const parameters = request.arguments ?? {};
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw fail('INVALID_ARGUMENTS', 'Tool arguments must be a JSON object');
  return parameters;
}
async function call(socket, request) {
  requireController(socket);
  const parameters = validateCall(request);
  const signature = createHash('sha256').update(stableJson({ name: request.name, arguments: parameters })).digest('hex');
  const prior = ledger.get(request.requestId);
  if (prior) {
    if (prior.signature !== signature) throw fail('REQUEST_ID_CONFLICT', 'requestId already belongs to a different tool or arguments');
    if (prior.state === 'pending') throw fail('REQUEST_PENDING', 'Original request is still unresolved; it will not be replayed', { uncertain: true });
    if (prior.error) throw fail(prior.error.code, prior.error.message, { uncertain: prior.error.uncertain });
    return prior.result;
  }
  const observation = request.name === 'get-session-status';
  const stopping = request.name === 'stop-movement';
  const quitting = request.name === 'disconnect-player';
  if (backendTransportClosed) throw fail('BACKEND_ENDED', 'Backend process ended; start a new session explicitly');
  if (backendEnded && !observation && !stopping) throw fail('BACKEND_ENDED', 'Game session ended; automatic reconnect is disabled');
  if ((detachFence || uncertain || safetyStop) && !observation && !stopping && !quitting) throw fail('FENCED', 'Old work or an uncertain outcome prevents new mutations; no automatic recovery', { uncertain });
  if (activeCall && !observation && !stopping && !quitting) throw fail('ACTION_BUSY', 'Another action is still running; no request was queued');
  if (ledger.size >= MAX_REQUESTS) throw fail('LEDGER_FULL', 'Session request limit reached; accepted IDs are never evicted or replayed');
  if (ledgerBytes + MAX_FRAME_BYTES > MAX_LEDGER_BYTES) throw fail('LEDGER_FULL', 'Session result budget reached; accepted IDs are never evicted or replayed');
  ledgerBytes += MAX_FRAME_BYTES; // Reserve one bounded result before issuing any action.
  const record = { requestId: request.requestId, name: request.name, signature, state: 'pending', result: null, error: null, settled: null };
  ledger.set(request.requestId, record); // Register before dispatch; retries can never issue another action.
  if (!observation && !stopping && !quitting) activeCall = record;
  let settle;
  record.settled = new Promise(resolve => { settle = resolve; });
  persistStatus();
  try {
    if (quitting) markBackendEnded('user_requested_disconnect');
    const result = await rawCall(request.name, parameters);
    const resultBytes = Buffer.byteLength(JSON.stringify(result)) + 512;
    if (resultBytes > MAX_FRAME_BYTES) throw Error('Backend result exceeds IPC response limit');
    record.result = result;
    record.bytes = resultBytes;
    record.state = 'finished';
    if (observation || stopping) {
      backendStatus = parseBackendStatus(result);
      if (backendStatus.ended) markBackendEnded(backendStatus.endReason || 'game_session_ended');
    }
    if (quitting && !result.isError) markBackendEnded('user_requested_disconnect');
    if (!observation && !stopping && !quitting) {
      // A tool can return an ordinary isError while setting an inventory fence.
      // Refresh before releasing the broker lane so canMutate cannot advertise
      // authority that the backend has already revoked.
      await refreshStatus().catch(() => markUncertain('Post-action status could not be verified; session remains fenced'));
    }
    return result;
  } catch (error) {
    record.state = 'uncertain';
    record.error = errorValue(fail('OUTCOME_UNCERTAIN', 'Backend request outcome is uncertain; never retry or replay automatically', { uncertain: true }));
    markUncertain('A dispatched backend request did not return a valid confirmed response');
    throw fail(record.error.code, record.error.message, { uncertain: true });
  } finally {
    ledgerBytes -= MAX_FRAME_BYTES - (record.bytes ?? 512);
    if (activeCall === record) activeCall = null;
    settle();
    persistStatus();
  }
}
async function dispatch(socket, request) {
  switch (request.op) {
    case 'attach': {
      if (closing) throw fail('SHUTTING_DOWN', 'Game session is shutting down');
      if (request.expectedSessionId !== undefined && request.expectedSessionId !== sessionId) throw fail('SESSION_MISMATCH', 'Readiness manifest belongs to a different game session');
      if (controller && controller.socket !== socket) throw fail('CONTROLLER_BUSY', 'Another frontend owns this session; simultaneous controllers are forbidden');
      if (request.ipcVersion !== IPC_VERSION) throw fail('PROTOCOL_MISMATCH', 'Unsupported IPC protocol version');
      if (request.frontendVersion !== undefined && (typeof request.frontendVersion !== 'string' || request.frontendVersion.length > 100)) throw fail('INVALID_FRONTEND_VERSION', 'Invalid frontend version');
      controller ??= { socket, controllerId: randomUUID(), frontendVersion: request.frontendVersion ?? 'unknown' };
      persistStatus();
      return snapshot();
    }
    case 'list': return { ...catalog, server: backendServer, sessionId, backend: snapshot().backend };
    case 'status': {
      try { await refreshStatus(); } catch { if (!closing) markUncertain('Backend status cannot be verified; no automatic recovery'); }
      return snapshot();
    }
    case 'stop': {
      requireController(socket);
      if (backendTransportClosed) throw fail('BACKEND_ENDED', 'Backend process ended; no safety request can be delivered');
      // Safety cancellation is idempotent, coalesced, and deliberately outside
      // the gameplay request ledger, including when that ledger is exhausted.
      safetyStop ??= (async () => {
        try {
          const result = await rawCall('stop-movement');
          backendStatus = parseBackendStatus(result);
          if (backendStatus.ended) markBackendEnded(backendStatus.endReason || 'game_session_ended');
          return result;
        } catch {
          markUncertain('Explicit safety stop was not confirmed; session remains fenced');
          throw fail('OUTCOME_UNCERTAIN', 'Safety stop was not confirmed; no automatic gameplay retry', { uncertain: true });
        } finally { safetyStop = null; persistStatus(); }
      })();
      return safetyStop;
    }
    case 'call': return call(socket, request);
    case 'detach': return detach(socket);
    case 'quit': {
      requireController(socket);
      // Shutdown revokes all calls synchronously; flushing the response occurs
      // before sockets are closed. No other frame can sneak into the game lane.
      void shutdown('explicit_ipc_quit');
      return { quitRequested: true, sessionId, automaticReconnect: false };
    }
    default: throw fail('INVALID_OPERATION', 'Unsupported IPC operation');
  }
}
server.on('connection', socket => {
  if (closing || sockets.size >= 32) { socket.destroy(); return; }
  sockets.add(socket);
  socket.on('error', () => {});
  socket.once('close', () => { sockets.delete(socket); void detach(socket); });
  let buffer = Buffer.alloc(0), peerRequests = 0, peerStopPending = false;
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_FRAME_BYTES && !buffer.includes(10)) { socket.destroy(); return; }
    while (!socket.destroyed) {
      const newline = buffer.indexOf(10);
      if (newline < 0) break;
      if (newline + 1 > MAX_FRAME_BYTES) { socket.destroy(); return; }
      const line = buffer.subarray(0, newline).toString('utf8');
      buffer = buffer.subarray(newline + 1);
      let request;
      try {
        request = JSON.parse(line);
        if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(request.id)) {
          throw Error('A bounded string IPC id is required');
        }
      } catch { send(socket, { id: null, ok: false, error: errorValue(fail('INVALID_FRAME', 'Invalid JSON IPC frame or id')) }); socket.end(); return; }
      if (request.op === 'stop' && peerStopPending) {
        send(socket, { id: request.id, ok: false, error: errorValue(fail('STOP_PENDING', 'A safety stop acknowledgement is already pending on this peer')) });
        continue;
      }
      if (!['quit', 'detach', 'stop'].includes(request.op) && (peerRequests >= MAX_PEER_REQUESTS || outstandingRequests >= MAX_GLOBAL_REQUESTS)) {
        send(socket, { id: request.id, ok: false, error: errorValue(fail('TOO_MANY_REQUESTS', 'Too many outstanding IPC requests; no action was queued')) });
        continue;
      }
      peerRequests++; outstandingRequests++;
      if (request.op === 'stop') peerStopPending = true;
      void dispatch(socket, request).then(result => send(socket, { id: request.id, ok: true, result }),
        error => send(socket, { id: request.id, ok: false, error: errorValue(error) }))
        .finally(() => { peerRequests--; outstandingRequests--; if (request.op === 'stop') peerStopPending = false; });
    }
    if (buffer.length > MAX_FRAME_BYTES) socket.destroy();
  });
});
server.on('error', () => { if (!closing) void shutdown('ipc_listener_failed', 1); });
let shutdownPromise;
function shutdown(reason, exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  closing = true;
  controller = null;
  clearInterval(pollTimer);
  clearInterval(stopTimer);
  persistStatus();
  shutdownPromise = (async () => {
    server.close();
    if (!backendTransportClosed) {
      // Quit is deliberately independent of a stalled foreground request.
      // Bounded close below escalates the owned child to TERM/KILL if needed.
      try { await rawCall('disconnect-player', {}, 5000); } catch { /* Explicit quit still closes the owned process. */ }
    }
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    markBackendEnded(reason, true);
    for (const socket of sockets) socket.destroy();
    try {
      const stat = lstatSync(socketPath);
      if (boundSocketIdentity && stat.isSocket() && stat.uid === process.getuid() && stat.ino === boundSocketIdentity.ino && stat.dev === boundSocketIdentity.dev) unlinkSync(socketPath);
    } catch { /* The listener may have already removed its socket. */ }
    if (temporarySocketIdentity) {
      try {
        const stat = lstatSync(socketDirectory);
        if (stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && stat.ino === temporarySocketIdentity.ino && stat.dev === temporarySocketIdentity.dev) rmdirSync(socketDirectory);
      } catch { /* Never recursively delete an unexpected or replaced directory. */ }
    }
    closed = true;
    persistStatus();
    save('closed.json', { sessionId, at: new Date().toISOString(), closed: true, reason, exitCode, automaticReconnect: false });
    // Nothing should retain this explicitly ended daemon; pending SDK timers or
    // abandoned peer streams must not prevent the verified shutdown result.
    process.exitCode = exitCode;
    setTimeout(() => process.exit(exitCode), 25).unref();
  })();
  return shutdownPromise;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void shutdown(signal); });
try {
  await client.connect(transport, { timeout: 10000 });
  backendPid = transport.pid;
  backendServer = client.getServerVersion();
  catalog = await client.listTools();
  toolNames = new Set(catalog.tools.map(tool => tool.name));
  if (toolNames.size !== catalog.tools.length || !['get-session-status', 'stop-movement', 'disconnect-player'].every(name => toolNames.has(name))) throw Error('Backend tool catalog is invalid');
  await refreshStatus();
  if (closing) throw Error('Daemon shut down during startup');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); }); });
  chmodSync(socketPath, 0o600);
  boundSocketIdentity = lstatSync(socketPath);
  save('tools.json', { server: backendServer, tools: catalog.tools, sessionId });
  save('session.json', { sessionId, state: 'ready', pid: process.pid, backendPid, server: backendServer,
    toolCount: catalog.tools.length, socketPath, automaticReconnect: false, startedAt, protocolVersion: IPC_VERSION });
  persistStatus();
  pollTimer = setInterval(() => {
    if (pollBusy || closing || backendTransportClosed) return;
    pollBusy = true;
    void refreshStatus().catch(() => { if (!closing) markUncertain('Backend status polling failed; no automatic recovery'); }).finally(() => { pollBusy = false; });
  }, 2000);
  stopTimer = setInterval(() => {
    const stopPath = join(stateDir, 'stop.request');
    if (!existsSync(stopPath)) return;
    try {
      const stat = lstatSync(stopPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 4096) {
        markUncertain('Invalid explicit stop marker'); return;
      }
      // Content is deliberately not executed or interpreted; existence in the
      // private owned directory is the launcher's explicit Stop MCPBot request.
      void shutdown('explicit_stop_request');
    } catch { markUncertain('Could not verify explicit stop marker'); }
  }, 250);
} catch (error) {
  save('error.json', { sessionId, at: new Date().toISOString(), message: String(error.message).slice(0, 400), automaticRetry: false });
  await shutdown('startup_failed', 1);
}
