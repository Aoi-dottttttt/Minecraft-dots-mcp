import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

export const WORLD_FILE_INTERVAL_MS = 2000;
export const WORLD_FILE_MAX_BYTES = 256 * 1024;
export const WORLD_FILE_CELL_COUNT = 17 * 13 * 17;
const VALID_FOR_MS = 5000;
type Point = { x: number; y: number; z: number };
type Scalar = number | null;
export type WorldFileReason = 'starting' | 'observed' | 'respawn' | 'death' | 'disconnected' | 'closed' | 'invalid-observation';
export type WorldVolume = {
  origin: Point; size: Point; order: 'y,z,x';
  stateIds: Scalar[]; biomes: Scalar[]; skyLight: Scalar[]; blockLight: Scalar[];
};
export type WorldFileFrame = {
  schemaVersion: 1; minecraftVersion: '1.21.1'; generation: number; sequence: number;
  capturedAt: string; validUntil: string; status: 'live' | 'stale'; reason: WorldFileReason;
  position: Point | null; yaw: number | null; pitch: number | null; volume: WorldVolume | null;
};

function point(value: Point | undefined): Point {
  if (!value || ![value.x, value.y, value.z].every(Number.isFinite) ||
      Math.abs(value.x) > 29999984 || Math.abs(value.z) > 29999984 || Math.abs(value.y) > 2048) {
    throw Error('World observation position is unavailable or outside bounds');
  }
  return { x: value.x, y: value.y, z: value.z };
}
const light = (value: unknown): Scalar => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 15 ? Number(value) : null;
const safeId = (value: unknown, limit: number): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= limit;
const errno = (error: unknown): string | undefined => (error as { code?: string })?.code;

/** Only synchronous blockAt over already loaded client data; never fetch/generate chunks. */
export function captureWorldVolume(bot: Bot): Pick<WorldFileFrame, 'position' | 'yaw' | 'pitch'> & { volume: WorldVolume } {
  if (bot.version !== '1.21.1') throw Error('World-file prototype supports only Minecraft Java 1.21.1');
  const position = point(bot.entity?.position), yaw = bot.entity?.yaw, pitch = bot.entity?.pitch;
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch) || Math.abs(yaw) > Math.PI * 4 || Math.abs(pitch) > Math.PI) throw Error('World observation angles are unavailable or outside bounds');
  const origin = { x: Math.floor(position.x) - 8, y: Math.floor(position.y) - 6, z: Math.floor(position.z) - 8 };
  const volume: WorldVolume = { origin, size: { x: 17, y: 13, z: 17 }, order: 'y,z,x', stateIds: [], biomes: [], skyLight: [], blockLight: [] };
  for (let y = 0; y < 13; y++) for (let z = 0; z < 17; z++) for (let x = 0; x < 17; x++) {
    // extraInfos=false avoids even the optional painting lookup. Null is unknown,
    // never an assertion of air, visibility, navigability, or terrain ownership.
    const block = bot.blockAt(new Vec3(origin.x + x, origin.y + y, origin.z + z), false);
    const state = block?.stateId, biome = block?.biome?.id;
    volume.stateIds.push(safeId(state, 100000) && bot.registry.blocksByStateId[state] ? state : null);
    volume.biomes.push(safeId(biome, 65535) && bot.registry.biomes[biome] ? biome : null);
    volume.skyLight.push(light(block?.skyLight)); volume.blockLight.push(light(block?.light));
  }
  return { position, yaw, pitch, volume };
}

/** All existing path components must be real directories, never symlinks. */
async function inspectDirectoryPath(directory: string): Promise<void> {
  const root = parse(directory).root;
  let path = root;
  for (const part of directory.slice(root.length).split('/').filter(Boolean)) {
    path = join(path, part);
    try {
      const value = await lstat(path);
      if (value.isSymbolicLink() || !value.isDirectory()) throw Error('World output directory path must not contain symlinks or non-directories');
    } catch (error) { if (errno(error) !== 'ENOENT') throw error; }
  }
}

async function inspectPrivate(path: string, directory: boolean): Promise<void> {
  const value = await lstat(path);
  if (value.isSymbolicLink() || (directory ? !value.isDirectory() : !value.isFile())) throw Error('World output must be a private regular file in a real directory');
  if ((value.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && value.uid !== process.getuid())) throw Error('World output permissions/owner are not private');
}

export async function createPrivateWorldWriter(directoryInput: string, options: { name: 'world-frame.json' | 'mesh-frame.json'; maxBytes: number } = { name: 'world-frame.json', maxBytes: WORLD_FILE_MAX_BYTES }): Promise<{ path: string; write(frame: object, current: () => boolean): Promise<boolean> }> {
  if (!['world-frame.json', 'mesh-frame.json'].includes(options.name) || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 16 * 1024 * 1024) throw Error('Invalid bounded world output contract');
  if (!isAbsolute(directoryInput)) throw Error('World output directory must be absolute');
  const directory = resolve(directoryInput);
  if (directory === parse(directory).root) throw Error('World output requires a dedicated private directory');
  await inspectDirectoryPath(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await inspectDirectoryPath(directory); await inspectPrivate(directory, true);
  const path = join(directory, options.name);
  const destination = async (): Promise<void> => {
    try { await inspectPrivate(path, false); } catch (error) { if (errno(error) !== 'ENOENT') throw error; }
  };
  await destination();
  return { path, async write(frame, current) {
    const content = Buffer.from(JSON.stringify(frame) + '\n');
    if (content.length > options.maxBytes) throw Error('World observation exceeds the bounded file size');
    if (!current()) return false;
    await inspectDirectoryPath(directory); await inspectPrivate(directory, true); await destination();
    const temporary = join(directory, `.world-frame-${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let published = false, failure: unknown;
    try {
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      if (current()) {
        await destination();
        if (current()) { await rename(temporary, path); published = true; }
      }
    } catch (error) { failure = error; }
    finally {
      try { await unlink(temporary); } catch (error) { if (errno(error) !== 'ENOENT') failure ??= error; }
    }
    if (failure) throw failure;
    return published;
  } };
}

export interface WorldFileExporter {
  readonly path: string;
  /** Cadence-bounded; false when paused, busy, invalidated or called too soon. */
  sample(): Promise<boolean>;
  /** Wait for writes already requested; no game observation or control. */
  flush(): Promise<void>;
  /** Remove listeners and await the final clear/stale write after all old work. */
  close(): Promise<void>;
  /** Fixed diagnostic only, never arbitrary game text or file content. */
  getError(): 'world-file-write-failed' | null;
}

/**
 * Opt-in exporter: never activates itself or creates a socket, renderer, control
 * file, second bot, reconnect, game action or dependency installation.
 * A consumer MUST discard live frames after validUntil, including producer crash.
 */
export async function createWorldFileExporter(bot: Bot, options: { directory: string; initiallyReady?: boolean | (() => boolean) }): Promise<WorldFileExporter> {
  if (bot.version !== '1.21.1') throw Error('World-file prototype supports only Minecraft Java 1.21.1');
  const writer = await createPrivateWorldWriter(options.directory);
  // Evaluate late-install spawn evidence only AFTER asynchronous path setup.
  let generation = 0, sequence = 0, ready = typeof options.initiallyReady === 'function' ? options.initiallyReady() : options.initiallyReady === true, closed = false, ended = false;
  let busy = false, lastCapture = -Infinity, error: 'world-file-write-failed' | null = null;
  let lastWrite: Promise<boolean> = Promise.resolve(false);
  type Pending = { frame: WorldFileFrame; resolve(value: boolean): void; reject(error: unknown): void };
  let pending: Pending | undefined, draining: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const makeFrame = (reason: WorldFileReason, observation?: ReturnType<typeof captureWorldVolume>): WorldFileFrame => {
    const now = Date.now();
    return { schemaVersion: 1, minecraftVersion: '1.21.1', generation, sequence: ++sequence,
      capturedAt: new Date(now).toISOString(), validUntil: new Date(now + (observation ? VALID_FOR_MS : 0)).toISOString(),
      status: observation ? 'live' : 'stale', reason, position: null, yaw: null, pitch: null, volume: null, ...observation };
  };
  const pump = (): void => {
    if (draining) return;
    draining = Promise.resolve().then(async () => {
      while (pending) {
        const job = pending; pending = undefined;
        try {
          job.resolve(await writer.write(job.frame, () => job.frame.generation === generation && (job.frame.status === 'stale' || (!closed && !ended && ready))));
        } catch (failure) {
          error = 'world-file-write-failed'; ready = false; if (timer) clearInterval(timer);
          job.reject(failure);
        }
      }
    }).finally(() => { draining = undefined; if (pending) pump(); });
  };
  const enqueue = (frame: WorldFileFrame): Promise<boolean> => {
    // One in-flight write and one latest pending frame. Repeated invalidations
    // coalesce instead of accumulating an unbounded asynchronous write queue.
    pending?.resolve(false);
    const write = new Promise<boolean>((resolve, reject) => { pending = { frame, resolve, reject }; });
    lastWrite = write; pump();
    return write;
  };
  const invalidate = (reason: WorldFileReason): Promise<boolean> => {
    generation++; ready = false;
    return enqueue(makeFrame(reason));
  };
  const sample = async (): Promise<boolean> => {
    if (closed || ended || !ready || busy || performance.now() - lastCapture < WORLD_FILE_INTERVAL_MS) return false;
    busy = true; lastCapture = performance.now(); const observedGeneration = generation;
    try {
      let observation: ReturnType<typeof captureWorldVolume>;
      try { observation = captureWorldVolume(bot); }
      catch { await invalidate('invalid-observation'); return false; }
      if (observedGeneration !== generation || !ready || closed || ended) return false;
      return await enqueue(makeFrame('observed', observation));
    } finally { busy = false; }
  };
  const discardRejection = (work: Promise<unknown>): void => { void work.catch(() => {}); };
  const spawn = (): void => { if (!closed && !ended && !error) { ready = true; discardRejection(sample()); } };
  const respawn = (): void => { if (!closed && !ended) discardRejection(invalidate('respawn')); };
  const death = (): void => { if (!closed && !ended) discardRejection(invalidate('death')); };
  const end = (): void => { if (!closed && !ended) { ended = true; detach(); discardRejection(invalidate('disconnected')); } };
  const detach = (): void => {
    if (timer) clearInterval(timer);
    bot.removeListener('spawn', spawn); bot.removeListener('respawn', respawn); bot.removeListener('death', death); bot.removeListener('end', end); bot.removeListener('kicked', end);
  };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true; detach();
    closePromise = invalidate('closed').then(() => {});
    return closePromise;
  };
  bot.on('spawn', spawn); bot.on('respawn', respawn); bot.on('death', death); bot.on('end', end); bot.on('kicked', end);
  try {
    await enqueue(makeFrame('starting'));
    if (ready && !ended) await sample();
    if (!ended && !closed && !error) { timer = setInterval(() => discardRejection(sample()), WORLD_FILE_INTERVAL_MS); timer.unref(); }
  } catch (failure) { closed = true; detach(); throw failure; }
  return { path: writer.path, sample, flush: async () => { await lastWrite; }, close, getError: () => error };
}
