#!/usr/bin/env node
// Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
import assert from 'node:assert/strict';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Local handshake fixture only: no Minecraft service, world, credentials, or
// deployment configuration is involved. The fixture deliberately ends login.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function readVarInt(buffer, start = 0) {
  let value = 0;
  for (let offset = 0; offset < 5; offset++) {
    const byte = buffer[start + offset];
    if (byte === undefined) return null;
    value |= (byte & 0x7f) << (7 * offset);
    if (!(byte & 0x80)) return { value, next: start + offset + 1 };
  }
  throw new Error('Invalid VarInt');
}
function readString(buffer, start) {
  const size = readVarInt(buffer, start);
  assert.ok(size && buffer.length >= size.next + size.value, 'Complete string required');
  return { value: buffer.toString('utf8', size.next, size.next + size.value), next: size.next + size.value };
}
const sockets = new Set();
const packets = [];
let connectionCount = 0;
let incoming = Buffer.alloc(0);
const listener = net.createServer(socket => {
  connectionCount++;
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => {});
  socket.on('data', data => {
    incoming = Buffer.concat([incoming, data]);
    while (incoming.length) {
      const length = readVarInt(incoming);
      if (!length || incoming.length < length.next + length.value) return;
      packets.push(incoming.subarray(length.next, length.next + length.value));
      incoming = incoming.subarray(length.next + length.value);
    }
    if (packets.length >= 2) socket.end();
  });
});
await new Promise((resolveListen, reject) => {
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', resolveListen);
});
const port = listener.address().port;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(root, 'dist/main.js'), '--connect', '--host', '127.0.0.1', '--port', String(port),
    '--username', 'ProtocolFixture', '--version', '1.21.1', '--auth', 'offline'],
  cwd: root,
  stderr: 'pipe',
  env: { PATH: process.env.PATH || '', HOME: '/tmp' }
});
transport.stderr?.on('data', () => {});
const client = new Client({ name: 'release-protocol-smoke', version: '1.0.0' });
const deadline = setTimeout(() => {
  process.stderr.write('Protocol smoke timed out\n');
  process.exitCode = 1;
  for (const socket of sockets) socket.destroy();
  void client.close();
  listener.close();
}, 15000);
try {
  await client.connect(transport);
  const end = Date.now() + 5000;
  while (packets.length < 2 && Date.now() < end) await new Promise(r => setTimeout(r, 20));
  assert.ok(packets.length >= 2, 'Expected handshake and offline login-start');
  const handshakeId = readVarInt(packets[0]);
  assert.equal(handshakeId.value, 0);
  const protocol = readVarInt(packets[0], handshakeId.next);
  assert.equal(protocol.value, 767, 'Minecraft 1.21.1 must use protocol 767');
  const host = readString(packets[0], protocol.next);
  assert.equal(host.value, '127.0.0.1');
  assert.equal(packets[0].readUInt16BE(host.next), port);
  assert.equal(readVarInt(packets[0], host.next + 2).value, 2, 'Must enter login, not version probing');
  const loginId = readVarInt(packets[1]);
  assert.equal(loginId.value, 0);
  assert.equal(readString(packets[1], loginId.next).value, 'ProtocolFixture');
  await new Promise(r => setTimeout(r, 250));
  const response = await client.callTool({ name: 'list-inventory', arguments: {} });
  assert.equal(response.isError, true, 'Incomplete login must never be reported as gameplay readiness');
  await new Promise(r => setTimeout(r, 2250));
  assert.equal(connectionCount, 1, 'Tool calls/disconnect must not reconnect automatically');
  await client.close();
  process.stdout.write(JSON.stringify({ passed: true, target: 'loopback synthetic TCP fixture',
    minecraftVersion: '1.21.1', protocol: 767, auth: 'offline', automaticReconnects: 0,
    fullGameplayTest: false, liveServerUsed: false, credentialsUsed: false }, null, 2) + '\n');
} finally {
  clearTimeout(deadline);
  await client.close();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolveClose => listener.close(resolveClose));
}
