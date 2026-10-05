import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { getInventoryAuthority } from './inventory-authority.js';

type Point = { x: number; y: number; z: number };
type Change = { position: Point; stateId: number };
type Chunk = { x: number; z: number };
const air = new Set(['air', 'cave_air', 'void_air']);
const key = (point: Point) => new Vec3(point.x, point.y, point.z).toString();

/** Session-local evidence of our own placements, never a persisted ownership claim. */
export class PlacementProvenance extends EventEmitter {
  private readonly blocks = new Map<string, { name: string; dimension: string }>();
  private generation = 0;

  constructor(private readonly bot: Bot) {
    super();
    bot._client.on('block_change', (packet: { location: Point; type: number }) => this.changed({ position: packet.location, stateId: packet.type }));
    bot._client.on('multi_block_change', (packet: { chunkCoordinates: Point; records: number[] }) => {
      if (!packet.chunkCoordinates || !Array.isArray(packet.records)) return this.clear();
      for (const record of packet.records) {
        if (!Number.isSafeInteger(record)) { this.clear(); continue; }
        this.changed({ position: {
          x: packet.chunkCoordinates.x * 16 + ((record >> 8) & 15),
          y: packet.chunkCoordinates.y * 16 + (record & 15),
          z: packet.chunkCoordinates.z * 16 + ((record >> 4) & 15)
        }, stateId: record >>> 12 });
      }
    });
    const chunk = (packet: Chunk) => {
      if (!Number.isInteger(packet.x) || !Number.isInteger(packet.z)) return this.clear();
      for (const coordinate of this.blocks.keys()) {
        const values = coordinate.slice(1, -1).split(',').map(Number);
        if (Math.floor(values[0] / 16) === packet.x && Math.floor(values[2] / 16) === packet.z) this.blocks.delete(coordinate);
      }
      this.emit('invalidate', packet);
    };
    bot._client.on('unload_chunk', (packet: { chunkX: number; chunkZ: number }) => chunk({ x: packet.chunkX, z: packet.chunkZ }));
    // A replacement full chunk cannot prove that the same block survived an
    // observation gap, even when it has the same material at the same position.
    bot._client.on('map_chunk', chunk);
    bot._client.on('respawn', () => this.clear());
    bot.on('end', () => this.clear());
  }

  private changed(change: Change): void {
    const previous = this.blocks.get(key(change.position));
    if (previous && this.bot.registry.blocksByStateId[change.stateId]?.name !== previous.name) this.blocks.delete(key(change.position));
    this.emit('block', change);
  }

  private clear(): void { this.generation++; this.blocks.clear(); this.emit('invalidate', null); }

  has(point: Point): boolean {
    const coordinate = key(point);
    const entry = this.blocks.get(coordinate);
    if (!entry) return false;
    if (entry.dimension !== String(this.bot.game?.dimension) || this.bot.blockAt(new Vec3(point.x, point.y, point.z))?.name !== entry.name) {
      this.blocks.delete(coordinate); return false;
    }
    return true;
  }

  forget(point: Point): void { this.blocks.delete(key(point)); }

  entries(): Array<[string, string]> {
    return [...this.blocks].filter(([coordinate]) => {
      const [x, y, z] = coordinate.slice(1, -1).split(',').map(Number);
      return this.has({ x, y, z });
    }).map(([coordinate, entry]) => [coordinate, entry.name]);
  }

  /** Begin immediately before one placement attempt. No supplied expectation,
   * material name, successful response or optimistic world update grants trust.
   */
  begin(target: Vec3, expectedName: string): { arm: () => void; confirm: (timeoutMs: number, signal?: AbortSignal) => Promise<boolean>; dispose: () => void } | null {
    const bot = this.bot;
    const authority = getInventoryAuthority(bot);
    const frame = authority.getFrame(0);
    const handSlot = 36 + bot.quickBarSlot;
    const held = frame.slots[handSlot];
    if (bot.registry.version.version !== 767 || bot.game?.gameMode !== 'survival' ||
      !air.has(bot.blockAt(target)?.name ?? '') || !held || held.name !== expectedName ||
      !bot.registry.blocksByName[expectedName] || authority.cursor || !authority.cursorKnown || authority.fence) return null;
    const before = [...frame.slots];
    const after = held.count === 1 ? null : { ...held, count: held.count - 1 };
    const sequence = authority.sequence;
    const dimension = String(bot.game.dimension);
    const generation = this.generation;
    let serverConfirmed = false, invalid = false, disposed = false, consumed = false, armed = false, debitObserved = false;
    const block = (change: Change) => {
      if (!armed) return;
      if (key(change.position) !== key(target)) return;
      const matches = bot.registry.blocksByStateId[change.stateId]?.name === expectedName;
      if (serverConfirmed && !matches) invalid = true;
      serverConfirmed = matches;
    };
    const invalidate = (chunk: Chunk | null) => {
      if (!chunk || (Math.floor(target.x / 16) === chunk.x && Math.floor(target.z / 16) === chunk.z)) invalid = true;
    };
    const consistent = () => {
      if (generation !== this.generation || dimension !== String(bot.game?.dimension) || authority.frames.get(0) !== frame ||
        authority.ended || authority.fence || authority.cursor || !authority.cursorKnown || bot.currentWindow || bot.health <= 0) invalid = true;
      if (frame.slots.some((item, slot) => slot !== handSlot && !authority.same(item, before[slot]))) invalid = true;
      // An unchanged refresh is harmless before the debit. Once spent, even
      // an exact refund followed by the same debit breaks its causal history.
      const exactDebit = authority.same(frame.slots[handSlot], after);
      if ((debitObserved && !exactDebit) || (!exactDebit && !authority.same(frame.slots[handSlot], held))) invalid = true;
      if (frame.revisions[handSlot] > sequence && exactDebit) debitObserved = true;
    };
    this.on('block', block); this.on('invalidate', invalidate); authority.on('change', consistent);
    const dispose = () => {
      if (disposed) return;
      disposed = true; this.removeListener('block', block); this.removeListener('invalidate', invalidate); authority.removeListener('change', consistent);
    };
    return { dispose, arm: () => {
      consistent();
      if (armed || !air.has(bot.blockAt(target)?.name ?? '') || !authority.same(frame.slots[handSlot], held)) invalid = true;
      armed = true;
    }, confirm: async (timeoutMs, signal) => {
      if (consumed || disposed) return false;
      consumed = true;
      try {
        const proved = () => {
          consistent();
          return armed && !invalid && serverConfirmed && frame.revisions[handSlot] > sequence && authority.same(frame.slots[handSlot], after) && bot.blockAt(target)?.name === expectedName;
        };
        if (!proved() && !invalid) {
          try { await authority.waitFor(() => invalid || proved(), Math.max(1, timeoutMs), 'placement inventory debit', signal); }
          catch { return false; }
        }
        if (signal?.aborted || !proved()) return false;
        this.blocks.set(key(target), { name: expectedName, dimension });
        return true;
      } finally { dispose(); }
    } };
  }
}

const ledgers = new WeakMap<Bot, PlacementProvenance>();
export function installPlacementProvenance(bot: Bot): PlacementProvenance {
  let ledger = ledgers.get(bot);
  if (!ledger) { ledger = new PlacementProvenance(bot); ledgers.set(bot, ledger); }
  return ledger;
}
export function placementProvenance(bot: Bot): PlacementProvenance | undefined { return ledgers.get(bot); }
