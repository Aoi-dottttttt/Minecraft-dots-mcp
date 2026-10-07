/* eslint-disable @typescript-eslint/no-explicit-any */
import { constants, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import vm from 'node:vm';
import { Vec3 } from 'vec3';
import { z } from 'zod';
import { viewerAsset } from './viewer-compatibility.js';
import { createPrivateWorldWriter, WORLD_FILE_CELL_COUNT, WORLD_FILE_MAX_BYTES } from './world-file-export.js';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.21.1');
const Chunk = require('prismarine-chunk')('1.21.1');
export const MESH_MAX_VERTICES = 150000;
export const MESH_MAX_BYTES = 16 * 1024 * 1024;
const pointSchema = z.object({ x: z.number().finite().min(-29999984).max(29999984), y: z.number().finite().min(-2048).max(2048), z: z.number().finite().min(-29999984).max(29999984) }).strict();
const integerPoint = pointSchema.extend({ x: pointSchema.shape.x.int(), y: pointSchema.shape.y.int(), z: pointSchema.shape.z.int() });
const boundedArray = (scalar: z.ZodTypeAny) => z.array(scalar).length(WORLD_FILE_CELL_COUNT);
const frameSchema = z.object({
  schemaVersion: z.literal(1), minecraftVersion: z.literal('1.21.1'), generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  capturedAt: z.string().datetime(), validUntil: z.string().datetime(), status: z.enum(['live', 'stale']),
  reason: z.enum(['starting', 'observed', 'respawn', 'death', 'disconnected', 'closed', 'invalid-observation']),
  position: pointSchema.nullable(), yaw: z.number().finite().min(-Math.PI * 4).max(Math.PI * 4).nullable(), pitch: z.number().finite().min(-Math.PI).max(Math.PI).nullable(),
  volume: z.object({ origin: integerPoint, size: z.object({ x: z.literal(17), y: z.literal(13), z: z.literal(17) }).strict(), order: z.literal('y,z,x'),
    stateIds: boundedArray(z.number().int().min(0).max(100000).nullable()), biomes: boundedArray(z.number().int().min(0).max(65535).nullable()),
    skyLight: boundedArray(z.number().int().min(0).max(15).nullable()), blockLight: boundedArray(z.number().int().min(0).max(15).nullable()),
  }).strict().nullable(),
}).strict();
type SourceFrame = z.infer<typeof frameSchema>;
export type MeshSection = { offset: [number, number, number]; positions: number[]; normals: number[]; colors: number[]; uvs: number[]; indices: number[] };
export type MeshFrame = {
  schemaVersion: 1; sourceGeneration: number | null; sourceSequence: number | null; capturedAt: string; validUntil: string;
  status: 'live' | 'stale'; reason: string; bounded: true; bounds: { origin: { x: number; y: number; z: number }; size: { x: number; y: number; z: number } } | null;
  unknownCells: number; unknownIndices: number[]; estimatedTintCells: number; estimatedLightCells: number;
  position: { x: number; y: number; z: number } | null; yaw: number | null; pitch: number | null; sections: MeshSection[];
};

export function staleMesh(reason: string, source?: SourceFrame): MeshFrame {
  const at = new Date().toISOString();
  return { schemaVersion: 1, sourceGeneration: source?.generation ?? null, sourceSequence: source?.sequence ?? null,
    capturedAt: source?.capturedAt ?? at, validUntil: at, status: 'stale', reason, bounded: true, bounds: null,
    unknownCells: 0, unknownIndices: [], estimatedTintCells: 0, estimatedLightCells: 0, position: null, yaw: null, pitch: null, sections: [] };
}
function validateFrame(input: unknown): SourceFrame {
  const frame = frameSchema.parse(input);
  const captured = Date.parse(frame.capturedAt), until = Date.parse(frame.validUntil), now = Date.now();
  if (captured > now + 1000 || until - captured > 5000 || until < captured) throw Error('invalid-frame');
  if (frame.status === 'live') {
    if (!frame.position || frame.yaw === null || frame.pitch === null || !frame.volume || frame.reason !== 'observed') throw Error('invalid-frame');
    const { origin, stateIds, biomes } = frame.volume;
    if (origin.y < -64 || origin.y + 12 > 319) throw Error('unsupported-height');
    if (origin.x !== Math.floor(frame.position.x) - 8 || origin.y !== Math.floor(frame.position.y) - 6 || origin.z !== Math.floor(frame.position.z) - 8) throw Error('invalid-frame');
    if (stateIds.some(id => id !== null && !data.blocksByStateId[id]) || biomes.some(id => id !== null && !data.biomes[id])) throw Error('invalid-frame');
  } else if (frame.volume || frame.position || frame.yaw !== null || frame.pitch !== null) throw Error('invalid-frame');
  return frame;
}

/** Exact existing hash-checked 1.33.0 worker adapter. No sockets, fetch, require or filesystem in VM. */
export class OfficialMeshWorker {
  private context: vm.Context;
  private sections: MeshSection[] = [];
  private vertices = 0;
  private allowedSections = new Set<string>();
  private seenSections = new Set<string>();
  constructor() {
    const root = dirname(require.resolve('prismarine-viewer/package.json'));
    const context: any = { performance, TextEncoder, TextDecoder, AbortController, AbortSignal,
      console: { log() {}, warn() {}, error() {} },
      setInterval(callback: unknown) { context.tick = callback; },
      setTimeout() { throw Error('Unexpected worker timer'); }, clearTimeout() {},
      postMessage: (message: any) => this.accept(message),
    };
    context.self = context; this.context = vm.createContext(context);
    try { vm.runInContext(viewerAsset('worker.js'), this.context, { timeout: 15000 }); }
    catch { throw Error('Pinned geometry worker initialization failed'); }
    this.message({ type: 'version', version: '1.21.1' });
    this.context.blockStateJson = readFileSync(join(root, 'public/blocksStates/1.21.1.json'), 'utf8');
    vm.runInContext('self.onmessage({data:{type:"blockStates",json:JSON.parse(blockStateJson)}}); blockStateJson=undefined', this.context, { timeout: 15000 });
  }
  private message(data: unknown): void {
    this.context.payload = JSON.stringify(data);
    vm.runInContext('self.onmessage({data:JSON.parse(payload)});payload=undefined', this.context, { timeout: 15000 });
  }
  private accept(message: any): void {
    if (message?.type !== 'geometry') return;
    if (!this.allowedSections.has(message.key) || this.seenSections.has(message.key)) throw Error('invalid-geometry');
    this.seenSections.add(message.key);
    const g = message.geometry, count = g?.positions?.length / 3;
    if (!Number.isSafeInteger(count) || count < 0 || this.vertices + count > MESH_MAX_VERTICES) throw Error('geometry-limit');
    const list = (value: any, length: number, limit: number): number[] => {
      const vector = value as ArrayLike<number>;
      if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || vector.length !== length) throw Error('invalid-geometry');
      const result = Array.from(vector);
      if (result.some(number => !Number.isFinite(number) || Math.abs(number) > limit)) throw Error('invalid-geometry');
      return result;
    };
    const positions = list(g.positions, count * 3, 64), normals = list(g.normals, count * 3, 2), colors = list(g.colors, count * 3, 2), uvs = list(g.uvs, count * 2, 16);
    if (!g.indices || g.indices.length > count * 6 || g.indices.length % 3) throw Error('invalid-geometry');
    const indices = Array.from(g.indices) as number[];
    if (indices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= count)) throw Error('invalid-geometry');
    const origin = String(message.key).split(',').map(Number);
    const offset: [number, number, number] = [g.sx, g.sy, g.sz];
    if (offset.some((number, i) => !Number.isSafeInteger(number) || number !== origin[i] + 8)) throw Error('invalid-geometry');
    this.vertices += count;
    if (count) this.sections.push({ offset, positions, normals, colors, uvs, indices });
  }
  render(frame: SourceFrame): MeshSection[] {
    const volume = frame.volume!;
    for (const key of this.allowedSections) { const [x, y, z] = key.split(',').map(Number); this.message({ type: 'dirty', x, y, z, value: false }); }
    this.sections = []; this.vertices = 0; this.allowedSections.clear(); this.seenSections.clear();
    // Fresh worker world per frame prevents geometry/data from older dimensions
    // or a previous bounded crop leaking through any unloaded columns.
    this.message({ type: 'version', version: '1.21.1' });
    const chunks = new Map<string, any>();
    for (let y = 0; y < 13; y++) for (let z = 0; z < 17; z++) for (let x = 0; x < 17; x++) {
      const index = (y * 17 + z) * 17 + x;
      const wx = volume.origin.x + x, wy = volume.origin.y + y, wz = volume.origin.z + z;
      const cx = Math.floor(wx / 16) * 16, cz = Math.floor(wz / 16) * 16, key = `${cx},${cz}`;
      let chunk = chunks.get(key); if (!chunk) { chunk = new Chunk({ minY: -64, worldHeight: 384 }); chunks.set(key, chunk); }
      const local = new Vec3(wx & 15, wy, wz & 15);
      if (volume.stateIds[index] !== null) chunk.setBlockStateId(local, volume.stateIds[index]);
      chunk.setBiome(local, volume.biomes[index] ?? data.biomesByName.plains.id);
      chunk.setSkyLight(local, volume.skyLight[index] ?? 0); chunk.setBlockLight(local, volume.blockLight[index] ?? 0);
      this.allowedSections.add(`${cx},${Math.floor(wy / 16) * 16},${cz}`);
    }
    for (const [key, chunk] of chunks) { const [x, z] = key.split(',').map(Number); this.message({ type: 'chunk', x, z, chunk: chunk.toJson() }); }
    for (const key of this.allowedSections) { const [x, y, z] = key.split(',').map(Number); this.message({ type: 'dirty', x, y, z }); }
    vm.runInContext('tick()', this.context, { timeout: 15000 });
    if (this.seenSections.size !== this.allowedSections.size) throw Error('incomplete-geometry');
    return this.sections;
  }
}

/** Pure conversion apart from reading pinned renderer assets. Unknown/cropped cells
 * are internal blank meshing placeholders, NOT world-air or collision evidence. */
export function makeMeshFrame(input: unknown, worker: OfficialMeshWorker): MeshFrame {
  let source: SourceFrame;
  try { source = validateFrame(input); }
  catch (error) { return staleMesh(error instanceof Error && error.message === 'unsupported-height' ? 'unsupported-height' : 'invalid-source'); }
  if (source.status !== 'live') return staleMesh('source-stale', source);
  if (Date.parse(source.validUntil) <= Date.now()) return staleMesh('source-expired', source);
  try {
    const volume = source.volume!, sections = worker.render(source);
    if (Date.parse(source.validUntil) <= Date.now()) return staleMesh('source-expired', source);
    const unknownIndices = volume.stateIds.flatMap((id, index) => id === null ? [index] : []);
    const result: MeshFrame = { schemaVersion: 1, sourceGeneration: source.generation, sourceSequence: source.sequence, capturedAt: source.capturedAt, validUntil: source.validUntil,
      status: 'live', reason: 'bounded-reconstruction', bounded: true, bounds: { origin: volume.origin, size: volume.size },
      unknownCells: unknownIndices.length, unknownIndices, estimatedTintCells: volume.biomes.filter(id => id === null).length,
      estimatedLightCells: volume.skyLight.filter((light, i) => light === null || volume.blockLight[i] === null).length,
      position: source.position, yaw: source.yaw, pitch: source.pitch, sections };
    if (Buffer.byteLength(JSON.stringify(result)) > MESH_MAX_BYTES) return staleMesh('geometry-limit', source);
    return result;
  } catch { return staleMesh('geometry-error-or-limit', source); }
}

async function readSource(path: string): Promise<unknown> {
  // Reject FIFOs via fstat without first blocking in open waiting for a writer.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()) || info.size > WORLD_FILE_MAX_BYTES) throw Error('Unsafe world source');
    const buffer = Buffer.alloc(WORLD_FILE_MAX_BYTES + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > WORLD_FILE_MAX_BYTES) throw Error('Oversized world source');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}

export async function createMeshFileSidecar(directory: string): Promise<{ path: string; tick(): Promise<MeshFrame>; close(): Promise<void> }> {
  const writer = await createPrivateWorldWriter(directory, { name: 'mesh-frame.json', maxBytes: MESH_MAX_BYTES });
  const sourcePath = join(dirname(writer.path), 'world-frame.json');
  await writer.write(staleMesh('starting'), () => true);
  let worker: OfficialMeshWorker;
  try { worker = new OfficialMeshWorker(); } catch { await writer.write(staleMesh('renderer-unavailable'), () => true); throw Error('Pinned renderer unavailable'); }
  let closed = false, rescan = false, inflight: Promise<MeshFrame> | undefined, closing: Promise<void> | undefined;
  let last = staleMesh('starting'), lastTick = -Infinity;
  await writer.write(last, () => true);
  const tick = (): Promise<MeshFrame> => {
    if (closed) return Promise.resolve(staleMesh('closed'));
    if (inflight) { rescan = true; return inflight; }
    inflight = (async () => {
      let output: MeshFrame;
      try {
        const input = await readSource(sourcePath), source = validateFrame(input);
        const fresh = source.status === 'live' && Date.parse(source.validUntil) > Date.now();
        if (!fresh) output = staleMesh(source.status === 'live' ? 'source-expired' : 'source-stale', source);
        else if (performance.now() - lastTick < 2000) {
          output = last.status === 'live' && last.sourceGeneration === source.generation && Date.parse(last.validUntil) > Date.now() ? last : staleMesh('waiting-for-geometry', source);
        } else { lastTick = performance.now(); output = makeMeshFrame(input, worker); }
        if (output.status === 'live') {
          const latest = validateFrame(await readSource(sourcePath));
          if (latest.status !== 'live' || latest.generation !== output.sourceGeneration || (output !== last && latest.sequence !== output.sourceSequence) || Date.parse(latest.validUntil) <= Date.now()) output = staleMesh('source-changed', latest);
        }
      } catch { output = staleMesh('source-unavailable'); }
      if (closed) output = staleMesh('closed');
      await writer.write(output, () => !closed || output.status === 'stale'); last = output; return output;
    })().finally(() => {
      inflight = undefined;
      if (rescan && !closed) { rescan = false; void tick().catch(() => {}); }
    });
    return inflight;
  };
  return { path: writer.path, tick, close: () => {
    if (closing) return closing;
    closed = true;
    closing = (async () => { await inflight?.catch(() => {}); await writer.write(staleMesh('closed'), () => true); })();
    return closing;
  } };
}
