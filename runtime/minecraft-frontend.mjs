#!/usr/bin/env node
// Modified for the public-candidate release; see RELEASE.md.
// Restartable, attach-only MCP frontend. It never launches or reconnects a game.
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { IPC_VERSION, MAX_FRAME_BYTES, readDaemonSession, validateSocketPath, encodeFrame } from './minecraft-ipc.mjs';

export const FRONTEND_VERSION = '3.1.1-rc.2';
const { values } = parseArgs({ options: { attach: { type: 'string' } }, strict: true });
if (!values.attach) throw Error('An existing private --attach daemon directory is required; this frontend never starts a game');
const expectedSession = readDaemonSession(values.attach);
const socketPath = validateSocketPath(values.attach);
const socket = net.createConnection(socketPath);
const pending = new Map();
let buffer = Buffer.alloc(0), sequence = 0, closing = false, attached = false;
const frontendId = randomUUID();
let server;
function transportFailure(error, entry) {
  // A failed write/response cannot prove whether a dispatched call ran. Copy
  // the error per request: a concurrent status/list must not inherit its flag.
  return Object.assign(Error(error.message), error, { uncertain: entry.op === 'call' && entry.dispatched });
}
function rejectPending(error) {
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(transportFailure(error, entry)); }
  pending.clear();
}
function request(op, fields = {}, timeout = 185000) {
  if (socket.destroyed || closing && op !== 'detach') return Promise.reject(Error('Daemon connection is closed; no retry was attempted'));
  const id = frontendId + ':' + (++sequence);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      const error = Object.assign(Error('Daemon response timed out; outcome may be uncertain and will not be retried'), { uncertain: op === 'call' });
      reject(error);
      // A timeout revokes this controller instead of leaving continuous actions running.
      socket.destroy();
    }, timeout);
    const entry = { resolve, reject, timer, op, dispatched: false };
    pending.set(id, entry);
    try {
      const frame = encodeFrame({ id, op, ...fields });
      entry.dispatched = true;
      socket.write(frame);
    }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(transportFailure(error, entry)); socket.destroy(); }
  });
}
socket.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const newline = buffer.indexOf(10);
    if (newline < 0) {
      if (buffer.length > MAX_FRAME_BYTES) socket.destroy(Error('Oversized daemon frame'));
      return;
    }
    if (newline > MAX_FRAME_BYTES) { socket.destroy(Error('Oversized daemon frame')); return; }
    const line = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
    let response;
    try { response = JSON.parse(line.toString('utf8')); }
    catch { socket.destroy(Error('Invalid daemon frame')); return; }
    const entry = pending.get(response.id);
    if (!entry) continue; // Late/unknown responses are never treated as a different call.
    pending.delete(response.id); clearTimeout(entry.timer);
    if (response.ok === true) entry.resolve(response.result);
    else entry.reject(Object.assign(Error(response.error?.message || 'Daemon rejected request'), response.error || {}));
  }
});
socket.on('error', error => rejectPending(error));
socket.on('close', () => {
  rejectPending(Error('Daemon connection ended; no request was retried'));
  if (!closing) void shutdown(1);
});
async function shutdown(exitCode = 0) {
  if (closing) return;
  closing = true;
  if (attached && !socket.destroyed) await request('detach', {}, 3000).catch(() => {});
  socket.destroy();
  await server?.close().catch(() => {});
  process.exitCode = exitCode;
  // The frontend owns no game process. Exiting only closes its controller socket.
  setTimeout(() => process.exit(exitCode), 20).unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void shutdown(); });
process.stdin.on('end', () => { void shutdown(); });

try {
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const attachment = await request('attach', { frontendVersion: FRONTEND_VERSION, ipcVersion: IPC_VERSION, expectedSessionId: expectedSession.sessionId }, 10000);
  if (attachment.sessionId !== expectedSession.sessionId || attachment.backend?.pid !== expectedSession.backendPid || attachment.backend?.server?.version !== expectedSession.server?.version) throw Error('Attached daemon does not match the private session manifest');
  attached = true;
  server = new Server({ name: 'minecraft-mcp-minecraft-frontend', version: FRONTEND_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = await request('list', {}, 10000);
    return { ...result, tools: [...result.tools, {
      name: 'get-controller-status',
      description: 'Read frontend and persistent backend versions, controller ownership, and uncertainty state. Never reconnects or clears a fence.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    }] };
  });
  server.setRequestHandler(CallToolRequestSchema, async req => {
    try {
      if (req.params.name === 'get-controller-status') {
        const status = await request('status', {}, 10000);
        return { content: [{ type: 'text', text: JSON.stringify({ frontendVersion: FRONTEND_VERSION, frontendId, attachment, daemon: status }) }] };
      }
      if (req.params.name === 'get-session-status') {
        // Periodic observation is not an accepted gameplay action. Keep it out
        // of the non-evicting mutation ledger so idle sessions do not fill it.
        const status = await request('status', {}, 10000);
        if (!status.backend?.status) throw Error('Backend status is unavailable');
        return { content: [{ type: 'text', text: JSON.stringify(status.backend.status) }] };
      }
      // Safety operations remain available even if the immutable action ledger
      // is full. They cancel work or end this session; neither replays an action.
      if (req.params.name === 'stop-movement') return await request('stop');
      if (req.params.name === 'disconnect-player') {
        const result = await request('quit', {}, 10000);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      const supplied = req.params._meta?.minecraftRequestId;
      if (supplied !== undefined && (typeof supplied !== 'string' || !/^[A-Za-z0-9_.:/-]{1,160}$/.test(supplied))) throw Error('Invalid explicit minecraftRequestId');
      const requestId = supplied ?? (frontendId + ':' + randomUUID());
      return await request('call', { requestId, name: req.params.name, arguments: req.params.arguments ?? {} });
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({
        error: String(error.message).slice(0, 400), code: error.code || 'FRONTEND_REQUEST_FAILED',
        uncertain: error.uncertain === true, automaticRetry: false
      }) }] };
    }
  });
  server.onclose = () => { void shutdown(); };
  await server.connect(new StdioServerTransport());
} catch (error) {
  process.stderr.write(String(error.message).slice(0, 400) + '\n');
  await shutdown(1);
}
