import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import type { Bot } from 'mineflayer';
import type { InventoryAuthority, ServerItem } from './inventory-authority.js';

const require = createRequire(import.meta.url);
const MAX_CLIENTS = 4;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const point = (value?: { x: number; y: number; z: number }) => value ? { x: finite(value.x), y: finite(value.y), z: finite(value.z) } : null;
const safeName = (value: unknown): string | null => typeof value === 'string' && /^[a-z0-9_:.-]{1,96}$/.test(value) ? value : null;

function itemSnapshot(item: ServerItem | null, slot: number) {
  if (!item) return null;
  return { slot, name: safeName(item.name), type: finite(item.type), count: finite(item.count),
    durabilityUsed: finite(item.durabilityUsed), maxDurability: finite(item.maxDurability) };
}

/** Deliberate allowlist: never serialize a Bot, raw status, NBT, text or runtime state. */
export function observerSnapshot(bot: Bot, authority: InventoryAuthority) {
  const id = bot.currentWindow?.id ?? 0;
  const frame = authority.frames.get(id);
  const player = authority.frames.get(0);
  const window = (entry: typeof frame, windowId: number) => ({ id: windowId, ready: Boolean(entry?.fullRevision && !authority.ended),
    revision: entry?.fullRevision ?? 0, slots: entry?.fullRevision ? entry.slots.slice(0, 128).map(itemSnapshot) : [],
    inventoryStart: entry?.inventoryStart ?? null, inventoryEnd: entry?.inventoryEnd ?? null });
  return { readonly: true, capturedAt: new Date().toISOString(), version: safeName(bot.version),
    connected: !authority.ended, health: finite(bot.health), food: finite(bot.food), oxygen: finite(bot.oxygenLevel),
    position: point(bot.entity?.position), dimension: safeName(bot.game?.dimension), time: finite(bot.time?.timeOfDay),
    inventory: window(player, 0), currentWindow: { ...window(frame, id), type: safeName(bot.currentWindow?.type ?? 'minecraft:inventory') },
    authority: { sequence: authority.sequence, cursorKnown: authority.cursorKnown, fenced: Boolean(authority.fence),
      cursor: authority.cursorKnown ? itemSnapshot(authority.cursor, -1) : null } };
}

export function validateObserverPort(raw: string | number | undefined): number | null {
  if (raw === undefined) return null;
  if (!/^(0|[1-9][0-9]{0,4})$/.test(String(raw))) throw Error('Observer port must be 0 or an integer from 1024 to 65535');
  const port = Number(raw);
  if (port !== 0 && (port < 1024 || port > 65535)) throw Error('Observer port must be 0 or an integer from 1024 to 65535');
  return port;
}

export interface ReadonlyObserver { url: string; close(): Promise<void> }

/** Uses Prismarine's renderer/WorldView without its all-interface HTTP launcher. */
export async function startReadonlyObserver(bot: Bot, authority: InventoryAuthority,
  options: { port: number; viewDistance?: number } = { port: 0 }): Promise<ReadonlyObserver> {
  const port = validateObserverPort(options.port)!;
  const viewDistance = options.viewDistance ?? 2;
  if (!Number.isInteger(viewDistance) || viewDistance < 1 || viewDistance > 4) throw Error('Observer viewDistance must be 1..4');
  if (bot.version !== '1.21.1') throw Error('Read-only observer is validated only for Minecraft 1.21.1');
  const { WorldView } = require('prismarine-viewer/viewer/lib/worldView.js');
  const assets = require('minecraft-assets')('1.21.1');
  if (!assets) throw Error('Minecraft 1.21.1 observation assets are unavailable');
  const app = express();
  app.disable('x-powered-by');
  const http = createServer(app);
  http.requestTimeout = 10000;
  http.headersTimeout = 10000;
  http.keepAliveTimeout = 1000;
  http.maxHeadersCount = 32;
  let origin = '', closing = false;
  const allowed = (req: IncomingMessage): boolean => {
    if (req.socket.remoteAddress !== '127.0.0.1') return false;
    if (req.headers.host !== origin.slice('http://'.length)) return false;
    if (req.headers.origin && req.headers.origin !== origin) return false;
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site']))) return false;
    return true;
  };
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'self'; object-src 'none'; base-uri 'none'");
    if (!allowed(req)) { res.status(403).end('Local same-origin observation only'); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.status(405).setHeader('Allow', 'GET, HEAD'); res.end(); return; }
    next();
  });
  app.get('/api/snapshot', (_req, res) => { res.json(observerSnapshot(bot, authority)); });
  app.get('/textures/:name.png', (req, res) => {
    const name = safeName(req.params.name);
    const texture = name && assets.textureContent[name]?.texture;
    if (typeof texture !== 'string' || !texture.startsWith('data:image/png;base64,')) { res.status(404).end(); return; }
    res.type('png').send(Buffer.from(texture.slice('data:image/png;base64,'.length), 'base64'));
  });
  // The pinned worker's bundled AJV/ProtoDef compiles fixed protocol schemas.
  // Limit its eval allowance to this worker response, with no network access;
  // the dashboard and viewer document keep their stricter no-eval policy.
  app.get('/viewer/worker.js', (_req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'none'"); next();
  });
  app.use('/viewer', express.static(join(dirname(require.resolve('prismarine-viewer/package.json')), 'public'), { fallthrough: false, dotfiles: 'deny', etag: false }));
  app.use(express.static(fileURLToPath(new URL('../runtime/observer/', import.meta.url)), { fallthrough: false, dotfiles: 'deny', etag: false }));
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(404).end('Not found'); });
  const io = new Server(http, { path: '/viewer/socket.io', transports: ['polling', 'websocket'], serveClient: false,
    maxHttpBufferSize: 1024, allowRequest: (req, callback) => callback(null, allowed(req) && !closing && io.engine.clientsCount < MAX_CLIENTS) });
  // Check every HTTP polling request as well as the initial websocket upgrade.
  io.engine.use((req: IncomingMessage, res: ServerResponse, next: (error?: Error) => void) => {
    if (!allowed(req)) { res.writeHead(403); res.end(); return; }
    res.setHeader('Cache-Control', 'no-store'); next();
  });
  const cleanupClients = new Set<() => void>();
  io.on('connection', socket => {
    if (closing || !bot.world || !bot.entity?.position || authority.ended) { socket.disconnect(true); return; }
    let active = true;
    // WorldView registers mouseClick on its emitter. Never give it the socket's
    // input side: browser events have no path to raycasts, packets or controls.
    const output = { on() {}, emit(name: string, value: Record<string, unknown>) {
      if (!active) return;
      if (name === 'entity') {
        const entity = { ...value }; delete entity.username; delete entity.skin; delete entity.texture;
        socket.emit(name, entity);
      } else if (name === 'loadChunk') {
        const chunk = JSON.parse(String(value.chunk));
        // Chunk NBT can contain sign text or container/book data. Rendering
        // needs geometry/light only; never transmit block-entity payloads.
        chunk.blockEntities = {};
        socket.emit(name, { x: value.x, z: value.z, chunk: JSON.stringify(chunk) });
      } else socket.emit(name, value);
    } };
    const world = new WorldView(bot.world, viewDistance, bot.entity.position, output);
    const position = () => {
      if (!active || !bot.entity?.position) return;
      socket.emit('position', { pos: point(bot.entity.position), yaw: bot.entity.yaw, addMesh: true });
      void world.updatePosition(bot.entity.position).catch(() => socket.disconnect(true));
    };
    const unload = (pos: { x: number; y: number; z: number }) => world.unloadChunk(pos);
    const cleanup = () => {
      if (!active) return;
      active = false; bot.removeListener('move', position); bot.removeListener('chunkColumnUnload', unload);
      world.removeListenersFromBot(bot); cleanupClients.delete(cleanup);
    };
    cleanupClients.add(cleanup);
    // The upstream camera emits mouseClick for orbit gestures. Drop it without
    // reading its payload; all other application input disconnects the client.
    socket.onAny(name => { if (name !== 'mouseClick') socket.disconnect(true); });
    socket.once('disconnect', cleanup);
    socket.emit('version', bot.version);
    world.listenToBot(bot);
    bot.on('move', position); bot.on('chunkColumnUnload', unload);
    position();
    void world.init(bot.entity.position).catch(() => socket.disconnect(true));
  });
  let closePromise: Promise<void> | undefined;
  const reset = () => { io.disconnectSockets(true); };
  const end = () => { void close(); };
  const close = (): Promise<void> => {
    closePromise ??= new Promise<void>(resolve => {
      closing = true; bot.removeListener('end', end); bot.removeListener('respawn', reset);
      for (const cleanup of cleanupClients) cleanup();
      io.close(() => resolve());
      http.closeAllConnections();
    });
    return closePromise;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const failure = (error: Error) => reject(error);
      http.once('error', failure);
      http.listen(port, '127.0.0.1', () => {
        http.removeListener('error', failure);
        const address = http.address();
        if (!address || typeof address === 'string') { reject(Error('Observer listener missing')); return; }
        origin = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  } catch (error) { await close(); throw error; }
  bot.once('end', end); bot.on('respawn', reset);
  return { url: origin + '/', close };
}
