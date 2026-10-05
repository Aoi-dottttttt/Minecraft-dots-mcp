// Server-authoritative counterpart of the pinned awesome-mineflayer-mcp container/furnace tools.
// Reuses the verified equipment/crafting protocol-767 click pattern, never Mineflayer prediction.
import { EventEmitter } from 'node:events';
import type mineflayer from 'mineflayer';
import { getInventoryAuthority, type InventoryAuthority, type InventoryFrame, type ServerItem } from './inventory-authority.js';

export type WindowOptions = { timeoutMs?: number; signal?: AbortSignal };
export type WindowLayout = { type: string; containerSlots: number[]; inputSlots: number[]; outputSlots: number[]; roles: Record<string, number[]>; storage: boolean; supported: boolean; limitation?: string };
export type ItemView = { name: string; type: number; metadata: number; count: number; stackSize: number; identity: string };
export type WindowSnapshot = { id: number; type: string; stateId: number; revision: number; inventoryStart: number; inventoryEnd: number; layout: WindowLayout; slots: Array<{ slot: number; playerSlot: number | null; revision: number; item: ItemView | null }>; cursor: ItemView | null; cursorRevision: number; properties: Record<number, number>; evidence: 'server_packets' };
export type TransferOptions = WindowOptions & { sourceSlots: number[]; destinationSlots: number[]; itemType?: number; metadata?: number | null; itemName?: string; count?: number };
export type TransferResult = { transferred: number; itemName: string; sourceSlots: number[]; destinationSlots: number[]; window: WindowSnapshot };
export type ClickOptions = WindowOptions & { slot: number; mouseButton?: 0 | 1; expectedSlot?: ServerItem | null; expectedCursor?: ServerItem | null };
type Window = NonNullable<mineflayer.Bot['currentWindow']>;
type Context = { bot: mineflayer.Bot; authority: InventoryAuthority; frame: InventoryFrame; window: Window | null; tracker: WindowTracker; epoch: number; options: WindowOptions; deadline: number; submitted: boolean; fuelEvidence: FurnaceFuelEvidence | null };
const range = (start: number, end: number) => Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index);
const furnaceTypes = ['minecraft:furnace', 'minecraft:blast_furnace', 'minecraft:smoker'];
export const FURNACE_WINDOW_TYPES = [...furnaceTypes];
export const STORAGE_WINDOW_TYPES = [...range(1, 7).map(rows => `minecraft:generic_9x${rows}`), 'minecraft:generic_3x3', 'minecraft:shulker_box', 'minecraft:hopper'];
const blockMenus: Record<string, string[]> = {
  chest: ['minecraft:generic_9x3', 'minecraft:generic_9x6'], trapped_chest: ['minecraft:generic_9x3', 'minecraft:generic_9x6'],
  barrel: ['minecraft:generic_9x3'], ender_chest: ['minecraft:generic_9x3'],
  dispenser: ['minecraft:generic_3x3'], dropper: ['minecraft:generic_3x3'], hopper: ['minecraft:hopper'],
  furnace: ['minecraft:furnace'], blast_furnace: ['minecraft:blast_furnace'], smoker: ['minecraft:smoker'],
  crafting_table: ['minecraft:crafting'], anvil: ['minecraft:anvil'], chipped_anvil: ['minecraft:anvil'], damaged_anvil: ['minecraft:anvil'],
  grindstone: ['minecraft:grindstone'], smithing_table: ['minecraft:smithing'], cartography_table: ['minecraft:cartography'],
  stonecutter: ['minecraft:stonecutter'], loom: ['minecraft:loom'], enchanting_table: ['minecraft:enchantment'],
  brewing_stand: ['minecraft:brewing_stand'], beacon: ['minecraft:beacon'], crafter: ['minecraft:crafter_3x3']
};
function menusForBlock(name: string): string[] {
  if (/^(?:(?:white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_)?shulker_box$/.test(name)) return ['minecraft:shulker_box'];
  return blockMenus[name] ?? [];
}

/** A remembered coordinate/object is never permission to right-click a different block. */
export function validateWindowBlock(bot: mineflayer.Bot, target: Parameters<mineflayer.Bot['activateBlock']>[0], expectedTypes?: string[]): Parameters<mineflayer.Bot['activateBlock']>[0] {
  const position = target?.position;
  if (!position || ![position.x, position.y, position.z].every(Number.isInteger)) throw new Error('A loaded block at integer coordinates is required');
  const block = bot.blockAt(position);
  if (!block) throw new Error('The requested window block is no longer loaded; no interaction was sent');
  const actual = menusForBlock(block.name);
  const expected = expectedTypes ?? menusForBlock(target.name);
  if (!actual.length || !expected.length || !actual.some(type => expected.includes(type))) throw new Error(`Cannot open the requested window: current block is ${block.name}; inspect the current world and locate the correct workstation or container. No interaction was sent`);
  if (bot.entity.position.distanceTo(block.position) > 4.5) throw new Error('Move within 4.5 blocks of the current window block first');
  if (!bot.canSeeBlock(block)) throw new Error('The current window block is not visible; move to an unobstructed position first');
  if (bot.getControlState?.('sneak')) throw new Error('Stop sneaking before opening a block window; sneaking can use the held item instead');
  return block;
}

/** Exact Java 1.21.1 menu layouts. Unknown/mismatched windows are readable only after validation. */
export function windowLayout(type: string, inventoryStart: number): WindowLayout {
  let size: number; let inputs: number[]; let outputs: number[] = []; let roles: Record<string, number[]>; let storage = false;
  const rows = /^minecraft:generic_9x([1-6])$/.exec(type);
  if (rows || ['minecraft:generic_3x3', 'minecraft:shulker_box', 'minecraft:hopper'].includes(type)) {
    size = rows ? Number(rows[1]) * 9 : type === 'minecraft:generic_3x3' ? 9 : type === 'minecraft:shulker_box' ? 27 : 5;
    inputs = range(0, size); roles = { storage: inputs }; storage = true;
  } else if (furnaceTypes.includes(type)) { size = 3; inputs = [0, 1]; outputs = [2]; roles = { input: [0], fuel: [1], output: [2] }; }
  else {
    const layouts: Record<string, [number, Record<string, number[]>, number[]]> = {
      'minecraft:inventory': [9, { output: [0], crafting: [1, 2, 3, 4], head: [5], torso: [6], legs: [7], feet: [8], offhand: [45] }, [0]],
      'minecraft:crafting': [10, { output: [0], crafting: range(1, 10) }, [0]],
      'minecraft:anvil': [3, { input: [0], addition: [1], output: [2] }, [2]],
      'minecraft:grindstone': [3, { input: [0, 1], output: [2] }, [2]],
      'minecraft:smithing': [4, { template: [0], base: [1], addition: [2], output: [3] }, [3]],
      'minecraft:cartography': [3, { map: [0], addition: [1], output: [2] }, [2]],
      'minecraft:stonecutter': [2, { input: [0], output: [1] }, [1]],
      'minecraft:loom': [4, { banner: [0], dye: [1], pattern: [2], output: [3] }, [3]],
      'minecraft:enchantment': [2, { input: [0], lapis: [1] }, []],
      'minecraft:brewing_stand': [5, { bottles: [0, 1, 2], ingredient: [3], fuel: [4] }, []],
      'minecraft:merchant': [3, { payment: [0, 1], output: [2] }, [2]],
      'minecraft:beacon': [1, { payment: [0] }, []],
      'minecraft:crafter_3x3': [9, { crafting: range(0, 9) }, []]
    };
    const layout = layouts[type];
    if (!layout) throw new Error(`Unsupported exact window layout: ${type}; no click was sent`);
    [size, roles, outputs] = layout;
    inputs = range(0, size).filter(slot => !outputs.includes(slot));
  }
  if (inventoryStart !== size) throw new Error(`Window ${type} has ${inventoryStart} menu slots, expected ${size}; refusing an ambiguous slot mapping`);
  return { type, containerSlots: range(0, size), inputSlots: inputs, outputSlots: outputs, roles, storage, supported: true };
}

class WindowTracker extends EventEmitter {
  epoch = 0;
  properties = new Map<number, Record<number, number>>();
  propertySequence = 0;
  propertyRevisions = new Map<string, number>();
  constructor(bot: mineflayer.Bot) {
    super();
    const changed = () => { this.epoch++; this.emit('change'); };
    bot._client.on('open_window', (packet: { windowId: number }) => { this.properties.delete(packet.windowId); for (const key of this.propertyRevisions.keys()) if (key.startsWith(`${packet.windowId}:`)) this.propertyRevisions.delete(key); changed(); });
    bot._client.on('open_horse_window', changed);
    bot._client.on('close_window', changed);
    bot._client.on('respawn', changed);
    bot.on('windowClose', changed);
    bot.on('end', changed);
    bot._client.on('craft_progress_bar', (packet: { windowId: number; property: number; value: number }) => {
      const properties = this.properties.get(packet.windowId) ?? {};
      properties[packet.property] = packet.value;
      this.propertyRevisions.set(`${packet.windowId}:${packet.property}`, ++this.propertySequence);
      this.properties.set(packet.windowId, properties);
      this.emit('property', packet);
      this.emit('change');
    });
  }
}

/** One action's conservation ledger, never a reusable permission to lose fuel.
 * Vanilla 1.21.1 can consume a fuel between clicks and suppress an unchanged fuel
 * slot packet. Its fresh burn transition and exact cursor debit then account for
 * that one item. Only coal/charcoal and ordinary-furnace birch planks have
 * reviewed duration mappings; other fuels/remainders and re-ignition stay strict.
 */
class FurnaceFuelEvidence {
  private readonly initialFuel: ServerItem | null;
  private readonly expectedSlots: Array<ServerItem | null>;
  private readonly initiallyUnlit: boolean;
  private burnPropertySequence = 0;
  private previousBurn: number | undefined;
  private burnStarted = false;
  private invalid = false;
  private deposited = 0;
  private fuel: ServerItem | null = null;
  private readonly observe: (packet: { windowId: number; property: number; value: number }) => void;

  constructor(private readonly ctx: Context) {
    this.initialFuel = ctx.frame.slots[1];
    this.expectedSlots = [...ctx.frame.slots];
    this.previousBurn = ctx.tracker.properties.get(ctx.frame.id)?.[0];
    this.initiallyUnlit = this.previousBurn === 0;
    this.observe = packet => {
      if (packet.windowId !== ctx.frame.id || packet.property !== 0) return;
      if (this.previousBurn === 0 && Number.isInteger(packet.value) && packet.value > 0) {
        if (this.burnStarted) this.invalid = true;
        this.burnStarted = true;
        this.burnPropertySequence = ctx.tracker.propertySequence;
      } else if (this.previousBurn !== undefined && packet.value > this.previousBurn) {
        // A positive reset needs a separate re-ignition proof; do not guess.
        this.invalid = true;
      }
      this.previousBurn = packet.value;
    };
    ctx.tracker.on('property', this.observe);
  }

  dispose(): void { this.ctx.tracker.removeListener('property', this.observe); }

  deposit(slot: number, before: ServerItem | null, cursor: ServerItem | null, after: { slot: ServerItem | null; cursor: ServerItem | null }): number {
    const authority = this.ctx.authority;
    if (slot !== 1 || !cursor || !this.duration(cursor.name)) return 0;
    const amount = cursor.count - (after.cursor?.count ?? 0);
    if (!Number.isInteger(amount) || amount <= 0 || (before && !authority.same(before, cursor, false)) ||
      !authority.same(after.cursor, counted(cursor, cursor.count - amount)) ||
      !authority.same(after.slot, counted(cursor, (before?.count ?? 0) + amount))) return 0;
    if ((this.initialFuel && !authority.same(this.initialFuel, cursor, false)) || (this.fuel && !authority.same(this.fuel, cursor, false))) return 0;
    this.fuel = cursor;
    return amount;
  }

  private duration(name: string): number {
    const ordinary = String(this.ctx.window?.type) === 'minecraft:furnace';
    if (name === 'coal' || name === 'charcoal') return ordinary ? 1600 : 800;
    // Deliberately exact: Nether planks are nonflammable, and other fuel
    // durations/remainders need their own reviewed proof and regression.
    return ordinary && name === 'birch_planks' ? 300 : 0;
  }

  confirms(amount: number, before: ServerItem | null, after: ServerItem | null, sequence: number): boolean {
    const { authority, frame, tracker } = this.ctx;
    if (!amount || !this.fuel || this.invalid || !this.initiallyUnlit || !this.burnStarted) return false;
    const properties = tracker.properties.get(frame.id);
    const duration = this.duration(this.fuel.name);
    if (!properties || ![0, 1, 2, 3].every(key => Number.isInteger(properties[key])) ||
      properties[1] !== duration || properties[0] <= 0 || properties[0] > duration ||
      properties[3] <= 0 || properties[2] <= 0 || properties[2] > properties[3] || !this.expectedSlots[0] ||
      (tracker.propertyRevisions.get(`${frame.id}:2`) ?? 0) <= this.burnPropertySequence) return false;
    // Only the fuel may differ from the independently tracked click results.
    // Background smelting or another actor changing any other slot is ambiguous.
    if (frame.slots.length !== this.expectedSlots.length || frame.slots.some((item, slot) => slot !== 1 && !authority.same(item, this.expectedSlots[slot]))) return false;
    const observed = frame.slots[1];
    if (!authority.same(observed, counted(after, (after?.count ?? 0) - 1))) return false;
    // A stale fuel slot is evidence only for a net-zero single-item deposit.
    if (frame.revisions[1] <= sequence && (amount !== 1 || !authority.same(observed, before))) return false;
    // Count this burn exactly once across all clicks, including normal clicks
    // and a fuel decrease that was separately reported before the next click.
    const conserved = (this.initialFuel?.count ?? 0) + this.deposited + amount - 1;
    return conserved >= 0 && authority.same(observed, counted(this.fuel, conserved));
  }

  confirmed(slot: number, after: ServerItem | null, amount: number): void {
    if (slot === 1) {
      if (!amount) this.invalid = true;
      this.deposited += amount;
    } else this.expectedSlots[slot] = after;
  }
}
const trackers = new WeakMap<mineflayer.Bot, WindowTracker>();
const busy = new WeakSet<mineflayer.Bot>();
function trackerFor(bot: mineflayer.Bot): WindowTracker {
  let tracker = trackers.get(bot);
  if (!tracker) { tracker = new WindowTracker(bot); trackers.set(bot, tracker); }
  return tracker;
}
function timeout(options: WindowOptions): number {
  const value = options.timeoutMs ?? 5000;
  if (!Number.isInteger(value) || value < 1 || value > 120000) throw new Error('timeoutMs must be an integer from 1 to 120000');
  return value;
}
function assertProtocol(bot: mineflayer.Bot): void {
  if (bot.registry.version.version !== 767 || !bot.supportFeature('stateIdUsed')) throw new Error('Verified window actions require Java 1.21.1 / protocol 767');
}
function assertSignal(signal?: AbortSignal): void { if (signal?.aborted) throw new Error('Window action cancelled'); }
async function exclusive<T>(bot: mineflayer.Bot, operation: () => Promise<T>): Promise<T> {
  if (busy.has(bot)) throw new Error('Another verified window action is still running');
  busy.add(bot);
  try { return await operation(); } finally { busy.delete(bot); }
}
function alignNativeWindow(window: Window | null, frame: InventoryFrame, layout: WindowLayout): void {
  if (!window || !layout.supported) return;
  // These are local menu metadata only, corrected from the complete validated
  // server shape so native close/copyInventory uses the same player mapping.
  window.inventoryStart = frame.inventoryStart;
  window.inventoryEnd = frame.inventoryEnd;
  window.hotbarStart = frame.inventoryEnd - 9;
  window.craftingResultSlot = layout.outputSlots.length === 1 ? layout.outputSlots[0] : -1;
}
function current(bot: mineflayer.Bot, options: WindowOptions): Context {
  const authority = getInventoryAuthority(bot);
  authority.assertMutationReady(); assertProtocol(bot); assertSignal(options.signal);
  const window = bot.currentWindow;
  const frame = authority.getFrame(window?.id ?? 0);
  const layout = windowLayout(String(window?.type ?? 'minecraft:inventory'), frame.inventoryStart);
  alignNativeWindow(window, frame, layout);
  const tracker = trackerFor(bot);
  const ctx: Context = { bot, authority, frame, window, tracker, epoch: tracker.epoch, options, deadline: Date.now() + timeout(options), submitted: false, fuelEvidence: null };
  if (furnaceTypes.includes(String(window?.type))) ctx.fuelEvidence = new FurnaceFuelEvidence(ctx);
  return ctx;
}
async function withContext<T>(bot: mineflayer.Bot, options: WindowOptions, operation: (ctx: Context) => Promise<T>): Promise<T> {
  return exclusive(bot, async () => {
    const ctx = current(bot, options);
    try { return await operation(ctx); } finally { ctx.fuelEvidence?.dispose(); }
  });
}
function guard(ctx: Context): void {
  ctx.authority.assertMutationReady(); assertSignal(ctx.options.signal);
  if (ctx.tracker.epoch !== ctx.epoch || ctx.bot.currentWindow !== ctx.window || ctx.authority.frames.get(ctx.frame.id) !== ctx.frame) throw new Error('Window changed or closed during the action');
  if (Date.now() >= ctx.deadline) throw new Error('Window action deadline reached');
}
function view(authority: InventoryAuthority, item: ServerItem | null): ItemView | null {
  return item ? { name: item.name, type: item.type, metadata: item.metadata, count: item.count, stackSize: item.stackSize, identity: authority.identity(item) } : null;
}
export function readWindowVerified(bot: mineflayer.Bot): WindowSnapshot {
  const authority = getInventoryAuthority(bot); authority.assertReady();
  const frame = authority.getFrame(bot.currentWindow?.id ?? 0);
  const type = String(bot.currentWindow?.type ?? 'minecraft:inventory');
  let layout: WindowLayout;
  try { layout = windowLayout(type, frame.inventoryStart); }
  catch (error) { layout = { type, containerSlots: range(0, frame.inventoryStart), inputSlots: [], outputSlots: [], roles: {}, storage: false, supported: false, limitation: (error as Error).message }; }
  return { id: frame.id, type, stateId: frame.stateId, revision: authority.sequence, inventoryStart: frame.inventoryStart, inventoryEnd: frame.inventoryEnd, layout, slots: frame.slots.map((item, slot) => ({ slot, playerSlot: frame.id === 0 ? slot : slot >= frame.inventoryStart && slot < frame.inventoryEnd ? 9 + slot - frame.inventoryStart : null, item: view(authority, item), revision: frame.revisions[slot] })), cursor: view(authority, authority.cursor), cursorRevision: authority.cursorRevision, properties: { ...trackerFor(bot).properties.get(frame.id) }, evidence: 'server_packets' };
}

/** All wait listeners/timers are disposed before returning, including cancellation and window changes. */
async function waitEvidence(authority: InventoryAuthority, tracker: WindowTracker, signal: AbortSignal | undefined, deadline: number, predicate: () => boolean, validate: () => void, description: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); authority.removeListener('change', check); tracker.removeListener('change', check); signal?.removeEventListener('abort', check);
      error ? reject(error) : resolve();
    };
    const check = () => {
      try { validate(); if (predicate()) finish(); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    };
    authority.on('change', check); tracker.on('change', check); signal?.addEventListener('abort', check, { once: true });
    timer = setTimeout(() => finish(new Error(`Server confirmation timed out: ${description}`)), Math.max(1, deadline - Date.now()));
    check();
  });
}
function assertSlot(ctx: Context, slot: number): void {
  if (!Number.isInteger(slot) || slot < 0 || slot >= ctx.frame.slots.length) throw new Error('Slot is outside the authoritative window; dropping outside is never allowed');
  if (ctx.frame.revisions[slot] <= 0) throw new Error(`Slot ${slot} has no authoritative server evidence`);
}
function counted(item: ServerItem | null, count: number): ServerItem | null { return item && count > 0 ? { ...item, count } : null; }
function expectedClick(ctx: Context, slot: number, button: 0 | 1): { slot: ServerItem | null; cursor: ServerItem | null } {
  const item = ctx.frame.slots[slot]; const cursor = ctx.authority.cursor;
  if (!cursor) {
    const count = item ? button === 0 ? item.count : Math.ceil(item.count / 2) : 0;
    return { slot: counted(item, (item?.count ?? 0) - count), cursor: counted(item, count) };
  }
  if (!item || ctx.authority.same(item, cursor, false)) {
    const capacity = Math.min(cursor.stackSize, item?.stackSize ?? cursor.stackSize) - (item?.count ?? 0);
    const count = Math.max(0, Math.min(capacity, button === 0 ? cursor.count : 1));
    return { slot: counted(cursor, (item?.count ?? 0) + count), cursor: counted(cursor, cursor.count - count) };
  }
  return { slot: cursor, cursor: item };
}
async function click(ctx: Context, slot: number, button: 0 | 1, expected?: { slot: ServerItem | null; cursor: ServerItem | null }): Promise<void> {
  guard(ctx); assertSlot(ctx, slot);
  if (button !== 0 && button !== 1) throw new Error('Only left/right pickup clicks (mode 0) are supported');
  const layout = windowLayout(String(ctx.window?.type ?? 'minecraft:inventory'), ctx.frame.inventoryStart);
  const resultPickup = !ctx.authority.cursor && layout.outputSlots.includes(slot);
  if (resultPickup && button !== 0) throw new Error('Take workstation output as a complete stack with a left click');
  const after = expected ?? expectedClick(ctx, slot, button);
  if (ctx.authority.same(ctx.frame.slots[slot], after.slot) && ctx.authority.same(ctx.authority.cursor, after.cursor)) throw new Error('Click would not move any item; no packet was sent');
  const before = ctx.frame.slots[slot];
  // Explicit expected values must still describe the ordinary deposit before
  // the specialized furnace proof can be considered.
  const ordinary = expectedClick(ctx, slot, button);
  const fuelDeposit = ctx.authority.same(after.slot, ordinary.slot) && ctx.authority.same(after.cursor, ordinary.cursor)
    ? ctx.fuelEvidence?.deposit(slot, before, ctx.authority.cursor, after) ?? 0 : 0;
  const sequence = ctx.authority.sequence;
  let usedFuelEvidence = false;
  ctx.submitted = true;
  try {
    ctx.bot._client.write('window_click', { windowId: ctx.frame.id, stateId: ctx.frame.stateId, slot, mouseButton: button, mode: 0, changedSlots: [], cursorItem: ctx.authority.raw(ctx.authority.cursor) });
    await waitEvidence(ctx.authority, ctx.tracker, ctx.options.signal, ctx.deadline, () => {
      if (ctx.authority.cursorRevision <= sequence || !ctx.authority.same(ctx.authority.cursor, after.cursor)) return false;
      if (ctx.frame.revisions[slot] > sequence && (resultPickup || ctx.authority.same(ctx.frame.slots[slot], after.slot))) return true;
      usedFuelEvidence = ctx.fuelEvidence?.confirms(fuelDeposit, before, after.slot, sequence) ?? false;
      return usedFuelEvidence;
    }, () => guard(ctx), `window ${ctx.frame.id} slot ${slot} and cursor`);
    if (usedFuelEvidence) {
      guard(ctx);
      // Finish the current packet turn before accepting a partial property set.
      if (!ctx.authority.same(ctx.authority.cursor, after.cursor) || !ctx.fuelEvidence?.confirms(fuelDeposit, before, after.slot, sequence)) throw new Error('Furnace fuel confirmation changed before completion');
    }
    ctx.fuelEvidence?.confirmed(slot, after.slot, fuelDeposit);
  } catch (error) {
    ctx.authority.block(`Unconfirmed window click on slot ${slot}; inspect server inventory and cursor, do not repeat the action`);
    throw error;
  }
}
export async function clickWindowVerified(bot: mineflayer.Bot, options: ClickOptions): Promise<WindowSnapshot> {
  return withContext(bot, options, async ctx => {
    const specified = Object.hasOwn(options, 'expectedSlot') || Object.hasOwn(options, 'expectedCursor');
    if (specified && (!Object.hasOwn(options, 'expectedSlot') || !Object.hasOwn(options, 'expectedCursor'))) throw new Error('Provide both expectedSlot and expectedCursor or neither');
    await click(ctx, options.slot, options.mouseButton ?? 0, specified ? { slot: options.expectedSlot ?? null, cursor: options.expectedCursor ?? null } : undefined);
    return readWindowVerified(bot);
  });
}

export async function openWindowVerified(bot: mineflayer.Bot, target: Parameters<mineflayer.Bot['activateBlock']>[0] | Parameters<mineflayer.Bot['activateEntity']>[0], options: WindowOptions & { expectedTypes?: string[]; entity?: boolean } = {}): Promise<Window> {
  return exclusive(bot, async () => {
    const authority = getInventoryAuthority(bot); authority.assertMutationReady(); assertProtocol(bot); assertSignal(options.signal);
    if (bot.currentWindow || authority.cursor) throw new Error('Close the current window and clear the cursor before opening another');
    if (!target?.position || bot.entity.position.distanceTo(target.position) > 4.5) throw new Error('Move within 4.5 blocks of the target first');
    // Reject stale or non-window blocks before entering the submitted-action fence.
    const currentTarget = options.entity ? target : validateWindowBlock(bot, target as Parameters<mineflayer.Bot['activateBlock']>[0], options.expectedTypes);
    const expectedTypes = options.expectedTypes ?? (options.entity ? undefined : menusForBlock((currentTarget as Parameters<mineflayer.Bot['activateBlock']>[0]).name));
    const tracker = trackerFor(bot); const sequence = authority.sequence; const epoch = tracker.epoch;
    const deadline = Date.now() + timeout(options);
    try {
      // Await activation itself, without Promise.race: its lookAt must settle before this
      // executor releases its lane, so an expired request cannot write in the background.
      if (options.entity) await bot.activateEntity(currentTarget as Parameters<mineflayer.Bot['activateEntity']>[0]);
      else await bot.activateBlock(currentTarget as Parameters<mineflayer.Bot['activateBlock']>[0]);
      await waitEvidence(authority, tracker, options.signal, deadline, () => {
        const window = bot.currentWindow; if (!window) return false;
        if (expectedTypes && !expectedTypes.includes(String(window.type))) throw new Error(`Unexpected window type ${window.type}`);
        const frame = authority.frames.get(window.id);
        if (!frame?.fullRevision || frame.fullRevision <= sequence) return false;
        const layout = windowLayout(String(window.type), frame.inventoryStart);
        alignNativeWindow(window, frame, layout);
        return true;
      }, () => {
        authority.assertMutationReady(); assertSignal(options.signal);
        if (tracker.epoch > epoch + 1) throw new Error('Window changed again before opening was confirmed');
        if (Date.now() >= deadline) throw new Error('Server confirmation timed out: opening window');
      }, 'open window with fresh authoritative contents');
      return bot.currentWindow!;
    } catch (error) { authority.block('Window opening did not complete safely; inspect current window before further actions'); throw error; }
  });
}

export async function closeWindowVerified(bot: mineflayer.Bot): Promise<{ closedWindowId: number | null; closePacketSent: boolean; serverAcknowledged: false }> {
  return exclusive(bot, async () => {
    const authority = getInventoryAuthority(bot); authority.assertMutationReady(); assertProtocol(bot);
    if (authority.cursor) throw new Error('Cursor is holding an item; return it before closing the window');
    const window = bot.currentWindow;
    if (!window) return { closedWindowId: null, closePacketSent: false, serverAcknowledged: false };
    // Standard close has no server acknowledgement. Never describe local windowClose as one.
    await bot.closeWindow(window);
    if (bot.currentWindow === window) throw new Error('Window close did not take effect locally');
    return { closedWindowId: window.id, closePacketSent: true, serverAcknowledged: false };
  });
}

function selectedItem(ctx: Context, options: TransferOptions): ServerItem {
  const items = options.sourceSlots.flatMap(slot => ctx.frame.slots[slot] ? [ctx.frame.slots[slot]!] : []);
  const matching = items.filter(item => (options.itemType === undefined || item.type === options.itemType) && (options.itemName === undefined || item.name === options.itemName.replace(/^minecraft:/, '')) && (options.metadata == null || item.metadata === options.metadata));
  if (!matching.length) throw new Error('No matching authoritative source item');
  const identities = new Set(matching.map(item => ctx.authority.identity(item)));
  if (identities.size !== 1) throw new Error('Source items have different names or components; select an exact source slot rather than mixing identities');
  return matching[0];
}
function capacity(ctx: Context, slots: number[], item: ServerItem): number {
  return slots.reduce((total, slot) => {
    const current = ctx.frame.slots[slot];
    return total + (!current ? item.stackSize : ctx.authority.same(current, item, false) ? Math.max(0, current.stackSize - current.count) : 0);
  }, 0);
}
async function transfer(ctx: Context, options: TransferOptions): Promise<TransferResult> {
  guard(ctx);
  if (ctx.authority.cursor) throw new Error('Clear the cursor before transferring items');
  if (!options.sourceSlots.length || !options.destinationSlots.length) throw new Error('Source and destination slots are required');
  if (new Set(options.sourceSlots).size !== options.sourceSlots.length || new Set(options.destinationSlots).size !== options.destinationSlots.length) throw new Error('Duplicate transfer slots are not allowed');
  for (const slot of [...options.sourceSlots, ...options.destinationSlots]) assertSlot(ctx, slot);
  if (options.sourceSlots.some(slot => options.destinationSlots.includes(slot))) throw new Error('Source and destination slots must not overlap');
  const layout = windowLayout(String(ctx.window?.type ?? 'minecraft:inventory'), ctx.frame.inventoryStart);
  if (options.destinationSlots.some(slot => layout.outputSlots.includes(slot))) throw new Error('Cannot deposit into a workstation output slot');
  const item = selectedItem(ctx, options);
  const available = options.sourceSlots.reduce((sum, slot) => sum + (ctx.authority.same(ctx.frame.slots[slot], item, false) ? ctx.frame.slots[slot]!.count : 0), 0);
  const requested = options.count ?? available;
  if (!Number.isInteger(requested) || requested < 1 || requested > available) throw new Error(`Requested count must be from 1 to ${available}; no items moved`);
  if (capacity(ctx, options.destinationSlots, item) < requested) throw new Error('Insufficient safe destination capacity; overflow will not be dropped');
  let remaining = requested;
  try {
    for (const sourceSlot of options.sourceSlots) {
      if (!remaining) break;
      guard(ctx);
      const stack = ctx.frame.slots[sourceSlot];
      if (!stack || !ctx.authority.same(stack, item, false)) continue;
      const amount = Math.min(remaining, stack.count);
      const half = Math.ceil(stack.count / 2);
      // Prefer a single half-stack pickup when it exactly matches the request.
      if (layout.outputSlots.includes(sourceSlot) && amount !== stack.count) throw new Error('Partial workstation output extraction is unsupported; take its complete authoritative stack');
      const button = !layout.outputSlots.includes(sourceSlot) && amount === half && amount !== stack.count ? 1 : 0;
      await click(ctx, sourceSlot, button);
      let toPlace = amount;
      for (const destination of options.destinationSlots) {
        if (!toPlace) break;
        guard(ctx);
        const free = capacity(ctx, [destination], item);
        let chunk = Math.min(toPlace, free);
        if (!chunk) continue;
        if (chunk === ctx.authority.cursor!.count || chunk === free) {
          const moved = Math.min(ctx.authority.cursor!.count, free);
          if (moved <= toPlace) { await click(ctx, destination, 0); toPlace -= moved; continue; }
        }
        while (chunk-- > 0) { await click(ctx, destination, 1); toPlace--; }
      }
      if (toPlace) throw new Error('Destination capacity changed during transfer');
      if (ctx.authority.cursor) {
        // Return unused items only to the server-verified source; never find/drop overflow.
        const cursor = ctx.authority.cursor as ServerItem;
        if (ctx.frame.slots[sourceSlot] && !ctx.authority.same(ctx.frame.slots[sourceSlot], cursor, false)) throw new Error('Source changed before returning remainder');
        if (capacity(ctx, [sourceSlot], cursor) < cursor.count) throw new Error('Source no longer has room for unused items');
        await click(ctx, sourceSlot, 0);
      }
      remaining -= amount;
    }
    if (remaining || ctx.authority.cursor) throw new Error('Exact transfer and empty cursor were not confirmed');
    return { transferred: requested, itemName: item.name, sourceSlots: [...options.sourceSlots], destinationSlots: [...options.destinationSlots], window: readWindowVerified(ctx.bot) };
  } catch (error) {
    if (ctx.submitted) ctx.authority.block('Window transfer stopped after mutation; inspect server slots and cursor before another action');
    throw error;
  }
}
export async function transferWindowVerified(bot: mineflayer.Bot, options: TransferOptions): Promise<TransferResult> {
  return withContext(bot, options, async ctx => transfer(ctx, options));
}
export function readFurnaceVerified(bot: mineflayer.Bot): WindowSnapshot & { input: ItemView | null; fuel: ItemView | null; output: ItemView | null; fuelProgress: number | null; smeltProgress: number | null } {
  const snapshot = readWindowVerified(bot);
  if (!furnaceTypes.includes(snapshot.type)) throw new Error('Open a furnace, blast furnace or smoker first');
  const properties = snapshot.properties;
  return { ...snapshot, input: snapshot.slots[0].item, fuel: snapshot.slots[1].item, output: snapshot.slots[2].item, fuelProgress: properties[1] > 0 && properties[0] !== undefined ? properties[0] / properties[1] : null, smeltProgress: properties[3] > 0 && properties[2] !== undefined ? properties[2] / properties[3] : null };
}
export async function furnaceActionVerified(bot: mineflayer.Bot, options: WindowOptions & { slot: 'input' | 'fuel' | 'output'; op: 'put' | 'take'; itemType?: number; itemName?: string; count?: number }): Promise<TransferResult> {
  const snapshot = readFurnaceVerified(bot);
  const slot = { input: 0, fuel: 1, output: 2 }[options.slot];
  if (slot === undefined || !['put', 'take'].includes(options.op)) throw new Error('Invalid furnace action');
  if (options.op === 'put' && slot === 2) throw new Error('Cannot put items into the furnace output');
  if (options.op === 'put' && options.itemType === undefined && options.itemName === undefined) throw new Error('A furnace deposit requires an exact item');
  return transferWindowVerified(bot, { ...options, sourceSlots: options.op === 'put' ? range(snapshot.inventoryStart, snapshot.inventoryEnd) : [slot], destinationSlots: options.op === 'put' ? [slot] : range(snapshot.inventoryStart, snapshot.inventoryEnd), count: options.count ?? (options.op === 'put' ? 1 : undefined) });
}

/** Select a vanilla stonecutter recipe or loom pattern; server property AND result must refresh. */
export async function selectWindowOptionVerified(bot: mineflayer.Bot, option: number, options: WindowOptions = {}): Promise<WindowSnapshot> {
  return withContext(bot, options, async ctx => {
    const type = String(ctx.window?.type);
    if (!['minecraft:stonecutter', 'minecraft:loom'].includes(type)) throw new Error('Menu option selection supports only stonecutter and loom windows');
    if (!Number.isInteger(option) || option < 0 || option > 255) throw new Error('Menu option must be an integer from 0 to 255');
    if (ctx.authority.cursor) throw new Error('Clear the cursor before selecting a menu option');
    const output = type === 'minecraft:loom' ? 3 : 1;
    const sequence = ctx.authority.sequence; const propertySequence = ctx.tracker.propertySequence;
    const key = `${ctx.frame.id}:0`;
    if (ctx.tracker.properties.get(ctx.frame.id)?.[0] === option && ctx.frame.slots[output]) return readWindowVerified(bot);
    try {
      ctx.submitted = true;
      // Mineflayer's enchantment helper uses this packet for vanilla menu buttons.
      bot._client.write('enchant_item', { windowId: ctx.frame.id, enchantment: option });
      await waitEvidence(ctx.authority, ctx.tracker, options.signal, ctx.deadline, () => (ctx.tracker.propertyRevisions.get(key) ?? 0) > propertySequence && ctx.tracker.properties.get(ctx.frame.id)?.[0] === option && ctx.frame.revisions[output] > sequence && !!ctx.frame.slots[output] && ctx.authority.cursor === null, () => guard(ctx), 'selected menu option and resulting output');
      return readWindowVerified(bot);
    } catch (error) { ctx.authority.block('Workstation menu selection was not confirmed; inspect its server state'); throw error; }
  });
}

/** Explicit item drop. This confirms removal from the inventory/cursor, not an entity landing. */
export async function dropItemVerified(bot: mineflayer.Bot, slot: number, count?: number, options: WindowOptions = {}): Promise<{ dropped: number; itemName: string; landingConfirmed: false; window: WindowSnapshot }> {
  return withContext(bot, options, async ctx => {
    if (ctx.window || ctx.authority.cursor) throw new Error('Close the window and clear the cursor before dropping items');
    assertSlot(ctx, slot);
    if (slot < 9 || slot >= 45) throw new Error('Drop source must be a player storage slot');
    const item = ctx.frame.slots[slot];
    if (!item) throw new Error('Drop source is empty');
    const amount = count ?? item.count;
    if (!Number.isInteger(amount) || amount < 1 || amount > item.count) throw new Error('Invalid drop count');
    try {
      await click(ctx, slot, 0);
      for (let keep = item.count - amount; keep > 0; keep--) await click(ctx, slot, 1);
      guard(ctx);
      const sequence = ctx.authority.sequence;
      bot._client.write('window_click', { windowId: 0, stateId: ctx.frame.stateId, slot: -999, mouseButton: 0, mode: 0, changedSlots: [], cursorItem: ctx.authority.raw(ctx.authority.cursor) });
      await waitEvidence(ctx.authority, ctx.tracker, options.signal, ctx.deadline, () => ctx.authority.cursorRevision > sequence && ctx.authority.cursor === null && ctx.authority.same(ctx.frame.slots[slot], counted(item, item.count - amount)), () => guard(ctx), 'explicit drop removed from cursor and source');
      return { dropped: amount, itemName: item.name, landingConfirmed: false, window: readWindowVerified(bot) };
    } catch (error) { if (ctx.submitted) ctx.authority.block('Explicit item drop was not confirmed; do not repeat it'); throw error; }
  });
}
