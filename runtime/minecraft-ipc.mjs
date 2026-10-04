// Modified for the public-candidate release; see RELEASE.md.
// Private local transport for one explicitly started, non-restarting game session.
import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const IPC_VERSION = 1;
export const SOCKET_NAME = 'control.sock';
export const MAX_FRAME_BYTES = 1024 * 1024;

// Do not follow links through any state-directory component. A private leaf is
// necessary even under a shared parent such as /tmp; never silently chmod it.
export function validateStateDir(value, { create = false } = {}) {
  if (typeof value !== 'string' || !value || typeof process.getuid !== 'function') {
    throw Error('A private user-owned Unix --state-dir is required');
  }
  const path = resolve(value);
  const chain = [];
  for (let current = path; ; current = dirname(current)) {
    chain.push(current);
    if (current === dirname(current)) break;
  }
  for (const current of chain.reverse()) {
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      mkdirSync(current, { mode: 0o700 });
      stat = lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('State directory ancestors must be real directories, not symlinks');
    if (![0, process.getuid()].includes(stat.uid) || ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)) {
      throw Error('State directory ancestors must have trusted ownership and no unprotected shared write access');
    }
  }
  const stat = lstatSync(path);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw Error('State directory must be user-owned and private (0700)');
  }
  return path;
}

export function readDaemonSession(stateDir) {
  const root = validateStateDir(stateDir), manifestPath = join(root, 'session.json');
  const stat = lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 65536) {
    throw Error('Daemon readiness manifest must be a bounded private user-owned file');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!manifest || manifest.state !== 'ready' || manifest.protocolVersion !== IPC_VERSION ||
      typeof manifest.sessionId !== 'string' || !/^[a-f0-9-]{36}$/.test(manifest.sessionId) ||
      typeof manifest.socketPath !== 'string' || !isAbsolute(manifest.socketPath) || resolve(manifest.socketPath) !== manifest.socketPath ||
      basename(manifest.socketPath) !== SOCKET_NAME || Buffer.byteLength(manifest.socketPath) > 100) {
    throw Error('Invalid daemon readiness manifest');
  }
  const socketDir = dirname(manifest.socketPath);
  if (socketDir !== root && !(dirname(socketDir) === '/tmp' && new RegExp('^minecraft-' + process.getuid() + '-[A-Za-z0-9]{6}$').test(basename(socketDir)))) {
    throw Error('Daemon socket must be inside its state directory or a private short Unix socket directory');
  }
  validateStateDir(socketDir);
  return manifest;
}

export function validateSocketPath(stateDir) {
  const path = readDaemonSession(stateDir).socketPath;
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw Error('Control socket must be a private user-owned Unix socket');
  }
  return path;
}

export function encodeFrame(value) {
  const text = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw Error('IPC frame exceeds size limit');
  return text;
}

export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
}
