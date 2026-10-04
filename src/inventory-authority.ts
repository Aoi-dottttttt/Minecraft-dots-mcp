// Modified for 2.1.0-dot.3 release (2026-10-04): protocol 767 unsigned container IDs.
// Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
import { EventEmitter } from 'node:events';
import { deserialize, serialize } from 'node:v8';
import { createRequire } from 'node:module';
import type mineflayer from 'mineflayer';

const require = createRequire(import.meta.url);
export type ServerItem = { type: number; count: number; metadata: number; name: string; stackSize: number; [key: string]: unknown };
export type InventoryFrame = { id: number; slots: Array<ServerItem | null>; revisions: number[]; stateId: number; fullRevision: number; inventoryStart: number; inventoryEnd: number };
type SlotPacket = { windowId: number; slot: number; stateId?: number; item: unknown };
type ItemsPacket = { windowId: number; stateId?: number; items: unknown[]; carriedItem?: unknown };

/** An independent record of server packets, never of Mineflayer's optimistic slot events. */
export class InventoryAuthority extends EventEmitter {
  readonly frames = new Map<number, InventoryFrame>();
  sequence = 0;
  cursor: ServerItem | null = null;
  cursorKnown = false;
  cursorRevision = 0;
  ended = false;
  fence: string | null = null;
  private fenceKind: 'death' | 'uncertain' | null = null;
  private respawnArmed = false;
  private dead = false;
  private readonly mutationGuards: Array<() => void> = [];
  private Item: { fromNotch(value: unknown): ServerItem | null; toNotch(value: ServerItem | null): unknown; equal(a: ServerItem | null, b: ServerItem | null, count?: boolean): boolean };

  constructor(readonly bot: mineflayer.Bot) {
    super();
    this.Item = require('prismarine-item')(bot.registry);
    bot._client.on('window_items', (packet: ItemsPacket) => this.onItems(packet));
    bot._client.on('set_slot', (packet: SlotPacket) => this.onSlot(packet));
    bot._client.on('set_cursor_item', (packet: { contents: unknown }) => { this.sequence++; this.setCursor(packet.contents); this.changed(); });
    bot._client.on('set_player_inventory', (packet: { slotId: number; contents: unknown }) => this.onSlot({ windowId: -2, slot: packet.slotId, item: packet.contents }));
    bot._client.on('open_window', (packet: { windowId: number }) => { this.frames.delete(packet.windowId); this.changed(); });
    bot._client.on('close_window', () => this.changed());
    bot.on('end', () => { this.ended = true; this.changed(); });
    bot.on('death', () => { this.dead = true; if (!this.fence) { this.fence = 'Player died; explicitly request respawn before continuing'; this.fenceKind = 'death'; } this.changed(); });
    bot._client.on('respawn', () => {
      this.frames.clear(); this.cursor = null; this.cursorKnown = false; this.dead = false;
      if (this.respawnArmed && this.fenceKind === 'death') { this.fence = null; this.fenceKind = null; }
      this.respawnArmed = false; this.changed();
    });
  }

  private frame(id: number, length = 46): InventoryFrame {
    let frame = this.frames.get(id);
    if (!frame) {
      // Full window packets are authoritative about the layout. In particular,
      // older prismarine-windows describes 1.21 smithing as 3 instead of 4 menu slots.
      const inventoryStart = id === 0 ? 9 : length >= 36 ? length - 36 : length;
      frame = { id, slots: Array(length).fill(null), revisions: Array(length).fill(0), stateId: -1, fullRevision: 0, inventoryStart, inventoryEnd: id === 0 ? 45 : length };
      this.frames.set(id, frame);
    }
    return frame;
  }

  private canonicalSlot(frame: InventoryFrame, slot: number): number | null {
    if (frame.id === 0) return slot;
    if (slot >= frame.inventoryStart && slot < frame.inventoryEnd) return 9 + slot - frame.inventoryStart;
    return null;
  }

  private set(frame: InventoryFrame, slot: number, item: ServerItem | null): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= frame.slots.length) return;
    frame.slots[slot] = item;
    frame.revisions[slot] = this.sequence;
    const canonical = this.canonicalSlot(frame, slot);
    if (frame.id !== 0 && frame.fullRevision > 0 && canonical !== null) {
      const player = this.frame(0);
      player.slots[canonical] = item;
      player.revisions[canonical] = this.sequence;
    }
  }

  private decode(raw: unknown): ServerItem | null { return this.Item.fromNotch(deserialize(serialize(raw))); }
  private mirror(item: ServerItem | null): ServerItem | null { return this.decode(this.Item.toNotch(item)); }

  private setCursor(raw: unknown): void {
    this.cursor = this.decode(raw);
    this.cursorKnown = true;
    this.cursorRevision = this.sequence;
    // Mineflayer 4.35 ignores the modern cursor correction. Preserve server truth.
    if (this.bot.inventory) this.bot.inventory.selectedItem = this.mirror(this.cursor) as typeof this.bot.inventory.selectedItem;
    if (this.bot.currentWindow) this.bot.currentWindow.selectedItem = this.mirror(this.cursor) as typeof this.bot.currentWindow.selectedItem;
  }

  private onItems(packet: ItemsPacket): void {
    if (packet.windowId < 0 || !Array.isArray(packet.items)) return;
    this.sequence++;
    const frame = this.frame(packet.windowId, packet.items.length);
    // A set_slot can arrive before the first full snapshot. Rebuild its shape
    // before mirroring player slots; never retain guessed/extra slots.
    frame.slots.length = packet.items.length;
    frame.revisions.length = packet.items.length;
    frame.inventoryStart = packet.windowId === 0 ? 9 : packet.items.length >= 36 ? packet.items.length - 36 : packet.items.length;
    frame.inventoryEnd = packet.windowId === 0 ? 45 : packet.items.length;
    if (Number.isInteger(packet.stateId)) frame.stateId = packet.stateId!;
    frame.fullRevision = this.sequence;
    for (let i = 0; i < packet.items.length; i++) this.set(frame, i, this.decode(packet.items[i]));
    if (Object.hasOwn(packet, 'carriedItem')) this.setCursor(packet.carriedItem);
    this.changed();
  }

  private onSlot(packet: SlotPacket): void {
    this.sequence++;
    // Protocol 767 encodes ContainerID as u8: special -1/-2 arrive as 255/254.
    // Do not apply this conversion to later protocols with varint container IDs.
    const windowId = this.bot.registry.version.version === 767 && (packet.windowId === 255 || packet.windowId === 254)
      ? packet.windowId - 256 : packet.windowId;
    if (windowId === -1 && packet.slot === -1) {
      this.setCursor(packet.item);
      // Protocol 767 cursor corrections advance the active menu's state ID too.
      // The packet's special ID is not a menu identifier: only associate it
      // with an existing, fully observed open menu. With no open menu a late
      // correction could belong to a recently closed container, so do not
      // guess that it advances player inventory or create an incomplete frame.
      const active = this.bot.currentWindow;
      const frame = active ? this.frames.get(active.id) : undefined;
      if (this.bot.registry.version.version === 767 && frame?.fullRevision && Number.isInteger(packet.stateId) && packet.stateId! >= 0 && packet.stateId! <= 32767) frame.stateId = packet.stateId!;
    } else if (windowId === -2) {
      if (!Number.isInteger(packet.slot) || packet.slot < 0 || packet.slot > 40) return;
      const frame = this.frame(0);
      const item = this.decode(packet.item);
      // Special -2 addresses vanilla Inventory indices, not container slot IDs.
      const playerSlot = packet.slot <= 8 ? packet.slot + 36 : packet.slot >= 36 && packet.slot <= 39 ? 44 - packet.slot : packet.slot === 40 ? 45 : packet.slot;
      this.set(frame, playerSlot, item);
      if (playerSlot >= 0 && playerSlot < this.bot.inventory.slots.length) {
        this.bot.inventory.updateSlot(playerSlot, this.mirror(item) as unknown as Parameters<typeof this.bot.inventory.updateSlot>[1]);
      }
      const active = this.bot.currentWindow;
      if (active && playerSlot >= 9 && playerSlot < 45) {
        const activeFrame = this.frames.get(active.id);
        // The native library can have an outdated menu width (e.g. smithing).
        // Only a complete server frame can map a special player correction back.
        if (activeFrame?.fullRevision) {
          const slot = activeFrame.inventoryStart + playerSlot - 9;
          this.set(activeFrame, slot, item);
          active.updateSlot(slot, this.mirror(item) as unknown as Parameters<typeof active.updateSlot>[1]);
        }
      }
    } else if (windowId >= 0) {
      const frame = this.frame(windowId);
      if (Number.isInteger(packet.stateId)) frame.stateId = packet.stateId!;
      this.set(frame, packet.slot, this.decode(packet.item));
    }
    this.changed();
  }

  private changed(): void { this.emit('change'); }
  block(reason: string): void { if (!this.fence || this.fenceKind === 'death') this.fence = reason; this.fenceKind = 'uncertain'; this.changed(); }
  armRespawnRecovery(): void { this.respawnArmed = this.dead && this.fenceKind === 'death'; }
  addMutationGuard(guard: () => void): void { this.mutationGuards.push(guard); }
  assertReady(): void {
    if (this.ended) throw new Error('Minecraft session ended');
    if (!this.frames.get(0)?.fullRevision || !this.cursorKnown) throw new Error('Waiting for an authoritative inventory and cursor snapshot from the server');
  }
  assertMutationReady(): void {
    for (const guard of this.mutationGuards) guard();
    this.assertReady();
    if (this.fence) throw new Error(`Inventory safety lock: ${this.fence}. Inspect inventory and start a new user-authorized session before more actions; no automatic retry`);
  }
  getFrame(id: number): InventoryFrame {
    const frame = this.frames.get(id);
    if (!frame?.fullRevision || frame.stateId < 0) throw new Error(`No complete authoritative snapshot for window ${id}`);
    return frame;
  }
  items(): Array<ServerItem & { slot: number }> {
    this.assertReady();
    return this.getFrame(0).slots.flatMap((item, slot) => slot >= 9 && slot < 45 && item ? [{ ...item, slot }] : []);
  }
  count(id: number, metadata: number | null = null): number {
    return this.items().filter(i => i.type === id && (metadata === null || i.metadata === metadata)).reduce((sum, i) => sum + i.count, 0);
  }
  identity(item: ServerItem, count = false): string {
    return JSON.stringify(this.raw(count ? item : { ...item, count: 1 }), (_key, value) => typeof value === 'bigint' ? { bigint: value.toString() } : value);
  }
  same(a: ServerItem | null, b: ServerItem | null, count = true): boolean {
    if (!a || !b) return a === b;
    return this.identity(a, count) === this.identity(b, count);
  }
  raw(item: ServerItem | null): unknown { return this.Item.toNotch(item); }

  async waitFor(predicate: () => boolean, timeoutMs: number, description: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.ended) throw new Error('Minecraft session ended');
    if (this.dead) throw new Error('Player died during server confirmation');
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); this.removeListener('change', check); signal?.removeEventListener('abort', aborted); error ? reject(error) : resolve(); };
      const aborted = () => finish(new Error('Server confirmation cancelled'));
      const check = () => {
        if (this.ended) return finish(new Error('Minecraft session ended'));
        if (this.dead) return finish(new Error('Player died during server confirmation'));
        try { if (predicate()) finish(); } catch (error) { finish(error as Error); }
      };
      const timer = setTimeout(() => finish(new Error(`Server confirmation timed out: ${description}`)), timeoutMs);
      this.on('change', check);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted(); else check();
    });
  }
}

const authorities = new WeakMap<mineflayer.Bot, InventoryAuthority>();
export function installInventoryAuthority(bot: mineflayer.Bot): InventoryAuthority {
  let authority = authorities.get(bot);
  if (!authority) { authority = new InventoryAuthority(bot); authorities.set(bot, authority); }
  return authority;
}
export function getInventoryAuthority(bot: mineflayer.Bot): InventoryAuthority {
  const authority = authorities.get(bot);
  if (!authority) throw new Error('Authoritative inventory tracking was not installed before login; restart through the updated user-controlled launcher');
  return authority;
}
