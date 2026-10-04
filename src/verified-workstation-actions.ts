// Bounded protocol-767 workstation counterparts of awesome-mineflayer-mcp
// 89a407ca18a4a39196c6ebe726d5208cff88a9e5 tools/enchant-anvil and tools/villager.
// Reuses Mineflayer's select_trade/enchant_item/name_item semantics, with only
// server-packet inventory proof and no uncancellable native helper promises.
import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { getInventoryAuthority, type InventoryAuthority, type ServerItem } from './inventory-authority.js';
import { closeWindowVerified, openWindowVerified, readWindowVerified, transferWindowVerified, type WindowOptions } from './verified-window-actions.js';
const require = createRequire(import.meta.url);
type ItemRef = string | number;
type Coordinates = { x: number; y: number; z: number };
type Selection = ServerItem & { slot: number };
type Trade = { input1: ServerItem; input2: ServerItem | null; output: ServerItem; price: number; disabled: boolean; maxUses: number; uses: number };
type RawTrade = { inputItem1: unknown; inputItem2?: unknown; outputItem: unknown; tradeDisabled?: boolean; maximumNbTradeUses: number; nbTradeUses: number; demand?: number; specialPrice?: number; priceMultiplier?: number };
type TradeSession = { window: NonNullable<Bot['currentWindow']>; trades: Trade[] };
const sessions = new WeakMap<Bot, TradeSession>();
const hasControl = (value: string): boolean => [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const range = (a: number, b: number): number[] => Array.from({ length: b - a }, (_, i) => a + i);

class WorkstationContext {
  readonly authority: InventoryAuthority;
  readonly deadline: number;
  readonly properties = new Map<number, { value: number; revision: number }>();
  propertyRevision = 0;
  submitted = false;
  window: NonNullable<Bot['currentWindow']> | null = null;
  private readonly onProperty = (packet: { windowId: number; property: number; value: number }): void => {
    if (packet.windowId === this.bot.currentWindow?.id) this.properties.set(packet.property, { value: packet.value, revision: ++this.propertyRevision });
  };
  constructor(readonly bot: Bot, readonly options: WindowOptions) {
    this.authority = getInventoryAuthority(bot);
    const timeout = options.timeoutMs ?? 10000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000) throw new Error('timeoutMs must be 1..120000');
    this.deadline = Date.now() + timeout;
    bot._client.on('craft_progress_bar', this.onProperty);
  }
  dispose(): void { this.bot._client.removeListener('craft_progress_bar', this.onProperty); }
  guard(): void {
    this.authority.assertMutationReady();
    this.options.signal?.throwIfAborted();
    if (this.bot.registry.version.version !== 767) throw new Error('Verified workstations require Java 1.21.1 / protocol 767');
    if (Date.now() >= this.deadline) throw new Error('Workstation confirmation timed out');
    if (this.window && this.bot.currentWindow !== this.window) throw new Error('Workstation changed or closed during the action');
  }
  remaining(): WindowOptions { this.guard(); return { signal: this.options.signal, timeoutMs: Math.max(1, this.deadline - Date.now()) }; }
  write(name: 'select_trade' | 'enchant_item' | 'name_item', packet: Record<string, unknown>): void {
    this.guard(); this.submitted = true; this.bot._client.write(name, packet);
  }
  async wait(predicate: () => boolean, description: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const cleanup = (): void => {
        clearTimeout(timer); this.authority.removeListener('change', check);
        this.bot._client.removeListener('craft_progress_bar', check); this.bot.removeListener('experience', check);
        this.bot.removeListener('windowClose', check); this.options.signal?.removeEventListener('abort', check);
      };
      const finish = (error?: Error): void => { if (done) return; done = true; cleanup(); error ? reject(error) : resolve(); };
      const check = (): void => { try { this.guard(); if (predicate()) finish(); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); } };
      this.authority.on('change', check); this.bot._client.on('craft_progress_bar', check); this.bot.on('experience', check);
      this.bot.on('windowClose', check); this.options.signal?.addEventListener('abort', check, { once: true });
      timer = setTimeout(() => finish(new Error(`Server confirmation timed out: ${description}`)), Math.max(1, this.deadline - Date.now()));
      check();
    });
  }
  frame() { this.guard(); return this.authority.getFrame(this.window?.id ?? this.bot.currentWindow?.id ?? 0); }
  async move(source: number, destinations: number[], count?: number): Promise<void> {
    this.submitted = true;
    await transferWindowVerified(this.bot, { sourceSlots: [source], destinationSlots: destinations, count, ...this.remaining() });
  }
  async returnInput(slot: number): Promise<void> {
    const frame = this.frame();
    if (frame.slots[slot]) await this.move(slot, range(frame.inventoryStart, frame.inventoryEnd));
  }
  async insert(item: Selection, slot: number, count = item.count): Promise<void> {
    const frame = this.frame(); const mapped = frame.inventoryStart + item.slot - 9;
    if (item.slot < 9 || item.slot >= 45 || !this.authority.same(frame.slots[mapped], item)) throw new Error('Selected inventory item changed after the workstation opened');
    await this.move(mapped, [slot], count);
  }
}
async function workflow<T>(bot: Bot, options: WindowOptions, operation: (ctx: WorkstationContext) => Promise<T>): Promise<T> {
  const ctx = new WorkstationContext(bot, options);
  try { ctx.guard(); return await operation(ctx); }
  catch (error) { if (ctx.submitted) ctx.authority.block('Workstation outcome was not fully confirmed; inspect server slots and cursor, do not repeat automatically'); throw error; }
  finally { ctx.dispose(); }
}
function select(bot: Bot, ref?: ItemRef, slot?: number): Selection {
  const authority = getInventoryAuthority(bot); const items = authority.items();
  const matches = slot !== undefined ? items.filter(i => i.slot === slot) : items.filter(i => typeof ref === 'number' ? i.type === ref : i.name === ref?.replace(/^minecraft:/, ''));
  if (!matches.length) throw new Error('Requested item is not in authoritative player storage');
  if (new Set(matches.map(i => authority.identity(i))).size > 1) throw new Error('Item has multiple component identities; select its exact inventory slot');
  return matches[0];
}
async function openBlock(ctx: WorkstationContext, position: Coordinates, type: string): Promise<void> {
  if (![position.x, position.y, position.z].every(Number.isSafeInteger)) throw new Error('Workstation coordinates must be safe integers');
  const block = ctx.bot.blockAt(new Vec3(position.x, position.y, position.z));
  if (!block) throw new Error('Workstation block is not loaded');
  ctx.window = await openWindowVerified(ctx.bot, block, { expectedTypes: [type], ...ctx.remaining() });
}
function hasEnchant(item: ServerItem | null): boolean {
  const components = item?.components as Array<{ type: string; data?: { enchantments?: unknown[] } }> | undefined;
  return !!components?.some(component => ['enchantments', 'stored_enchantments'].includes(component.type) && !!component.data?.enchantments?.length);
}
function customName(item: ServerItem): string {
  const components = item.components as Array<{ type: string; data?: unknown }> | undefined;
  const value = components?.find(component => component.type === 'custom_name')?.data;
  if (!value) return '';
  const simplified = require('prismarine-nbt').simplify(value) as string | { text?: string };
  return typeof simplified === 'string' ? simplified : simplified.text ?? '';
}
function itemView(item: ServerItem | null) { return item ? { name: item.name, type: item.type, count: item.count } : null; }
function holdings(ctx: WorkstationContext, excluded: number[] = []): Map<string, number> {
  const values = new Map<string, number>();
  ctx.frame().slots.forEach((item, index) => { if (item && !excluded.includes(index)) { const key = ctx.authority.identity(item); values.set(key, (values.get(key) ?? 0) + item.count); } });
  if (ctx.authority.cursor) { const key = ctx.authority.identity(ctx.authority.cursor); values.set(key, (values.get(key) ?? 0) + ctx.authority.cursor.count); }
  return values;
}
function adjust(values: Map<string, number>, authority: InventoryAuthority, item: ServerItem, count: number): void {
  const key = authority.identity(item); values.set(key, (values.get(key) ?? 0) + count);
}
function equalHoldings(a: Map<string, number>, b: Map<string, number>): boolean {
  return [...new Set([...a.keys(), ...b.keys()])].every(key => (a.get(key) ?? 0) === (b.get(key) ?? 0));
}

async function rejectWithoutLoss(ctx: WorkstationContext, before: Map<string, number>, inputs: number[], excluded: number[], message: string): Promise<never> {
  for (const slot of inputs) await ctx.returnInput(slot);
  if (!equalHoldings(before, holdings(ctx, excluded))) throw new Error('Workstation rejection did not conserve exact inputs');
  await closeWindowVerified(ctx.bot);
  ctx.submitted = false;
  throw new Error(message);
}

export async function enchantItemVerified(bot: Bot, args: Coordinates & WindowOptions & { item: ItemRef; choice?: number }): Promise<Record<string, unknown>> {
  return workflow(bot, args, async ctx => {
    const target = select(bot, args.item);
    const lapis = ctx.authority.items().find(item => item.name === 'lapis_lazuli');
    if (args.choice !== undefined && (!Number.isInteger(args.choice) || args.choice < 0 || args.choice > 2)) throw new Error('Enchant choice must be 0..2');
    await openBlock(ctx, args, 'minecraft:enchantment');
    const before = holdings(ctx); const propertyRevision = ctx.propertyRevision;
    await ctx.insert(target, 0, 1);
    if (lapis) await ctx.insert(lapis, 1);
    await ctx.wait(() => [0, 1, 2].every(i => (ctx.properties.get(i)?.revision ?? 0) > propertyRevision && (ctx.properties.get(i)?.value ?? -1) >= 0), 'fresh enchanting offers');
    const offers = [0, 1, 2].map(i => ({ slot: i, level: ctx.properties.get(i)!.value, enchant: ctx.properties.get(i + 4)?.value ?? null, enchantLevel: ctx.properties.get(i + 7)?.value ?? null }));
    if (args.choice === undefined) {
      await ctx.returnInput(0); await ctx.returnInput(1);
      if (!equalHoldings(before, holdings(ctx))) throw new Error('Enchant preview did not conserve exact items');
      await closeWindowVerified(bot);
      return { confirmed: true, offers, applied: false, itemsReturned: true };
    }
    const choice = args.choice; const cost = choice + 1; const frame = ctx.frame();
    if (!offers[choice].level || (bot.experience?.level ?? 0) < offers[choice].level) return rejectWithoutLoss(ctx, before, [0, 1], [], 'Enchant offer is unavailable or requires more experience; inputs were returned');
    const oldTarget = frame.slots[0]; const oldLapis = frame.slots[1];
    if (!oldTarget || !oldLapis || oldLapis.name !== 'lapis_lazuli' || oldLapis.count < cost) return rejectWithoutLoss(ctx, before, [0, 1], [], 'Insufficient confirmed lapis for the chosen enchantment; inputs were returned');
    const sequence = ctx.authority.sequence; const levels = bot.experience.level;
    const outputType = oldTarget.name === 'book' ? bot.registry.itemsByName.enchanted_book.id : oldTarget.type;
    ctx.write('enchant_item', { windowId: frame.id, enchantment: choice });
    await ctx.wait(() => frame.revisions[0] > sequence && frame.revisions[1] > sequence && frame.slots[0]?.type === outputType && frame.slots[0]?.count === 1 && hasEnchant(frame.slots[0]) && !ctx.authority.same(frame.slots[0], oldTarget, false) && bot.experience.level === levels - cost && (frame.slots[1]?.count ?? 0) === oldLapis.count - cost && (!frame.slots[1] || ctx.authority.same(frame.slots[1], oldLapis, false)), 'enchanted target and exact lapis consumption');
    const output = frame.slots[0]!; adjust(before, ctx.authority, target, -1); adjust(before, ctx.authority, output, 1); adjust(before, ctx.authority, oldLapis, -cost);
    await ctx.returnInput(0); await ctx.returnInput(1);
    if (!equalHoldings(before, holdings(ctx))) throw new Error('Enchanting item conservation did not match the confirmed result');
    await closeWindowVerified(bot);
    return { confirmed: true, choice, enchanted: itemView(output), identity: ctx.authority.identity(output), lapisConsumed: cost, itemsReturned: true };
  });
}

export async function anvilCombineVerified(bot: Bot, args: Coordinates & WindowOptions & { itemOneSlot?: number; itemOne?: ItemRef; itemTwoSlot?: number; itemTwo?: ItemRef; name?: string }): Promise<Record<string, unknown>> {
  return workflow(bot, args, async ctx => {
    const first = select(bot, args.itemOne, args.itemOneSlot);
    const second = args.itemTwoSlot !== undefined || args.itemTwo !== undefined ? select(bot, args.itemTwo, args.itemTwoSlot) : null;
    if (!second && args.name === undefined) throw new Error('Provide another item or a new name for the anvil');
    if (second?.slot === first.slot) throw new Error('Anvil inputs must be different inventory slots');
    if (args.name !== undefined && (args.name.length > 35 || hasControl(args.name))) throw new Error('Anvil name must contain at most 35 ordinary characters');
    await openBlock(ctx, args, 'minecraft:anvil');
    const before = holdings(ctx, [2]); const sequence = ctx.authority.sequence; const propertyRevision = ctx.propertyRevision;
    await ctx.insert(first, 0); if (second) await ctx.insert(second, 1);
    if (args.name !== undefined) ctx.write('name_item', { name: args.name });
    const frame = ctx.frame();
    await ctx.wait(() => frame.revisions[2] > sequence && !!frame.slots[2] && (args.name === undefined || customName(frame.slots[2]) === args.name) && (ctx.properties.get(0)?.revision ?? 0) > propertyRevision && (ctx.properties.get(0)?.value ?? 0) > 0, 'anvil output and server experience cost');
    const output = frame.slots[2]!; const cost = ctx.properties.get(0)!.value; const levels = bot.experience?.level;
    if (!Number.isInteger(levels) || levels < cost || cost >= 40) return rejectWithoutLoss(ctx, before, [0, 1], [2], 'Anvil cost exceeds available survival experience; inputs were returned');
    if (output.type !== first.type || output.count !== first.count) throw new Error('Anvil output does not match the selected base item');
    const takeSequence = ctx.authority.sequence;
    await ctx.move(2, range(frame.inventoryStart, frame.inventoryEnd));
    await ctx.wait(() => frame.revisions[0] > takeSequence && frame.slots[0] === null && bot.experience.level === levels - cost && (!second || frame.revisions[1] > takeSequence && (frame.slots[1] === null || ctx.authority.same(frame.slots[1], second, false) && frame.slots[1]!.count < second.count)), 'anvil input consumption and exact experience cost');
    adjust(before, ctx.authority, first, -first.count); adjust(before, ctx.authority, output, output.count);
    const consumed = second ? second.count - (frame.slots[1]?.count ?? 0) : 0;
    if (second) adjust(before, ctx.authority, second, -consumed);
    await ctx.returnInput(1);
    if (!equalHoldings(before, holdings(ctx, [2]))) throw new Error('Anvil inventory conservation did not match the confirmed result');
    await closeWindowVerified(bot);
    return { confirmed: true, combined: !!second, renamedTo: args.name ?? null, output: itemView(output), identity: ctx.authority.identity(output), experienceConsumed: cost, secondItemConsumed: consumed };
  });
}

export async function openVillagerVerified(bot: Bot, entityId: number, options: WindowOptions = {}): Promise<Record<string, unknown>> {
  return workflow(bot, options, async ctx => {
    const entity = bot.entities[entityId];
    if (!entity || entity.type === 'player' || entity.username || !['villager', 'wandering_trader'].includes(entity.name ?? '')) throw new Error('Target must be a currently tracked villager or wandering trader');
    const Item = require('prismarine-item')(bot.registry);
    let packet: { windowId: number; trades: RawTrade[] } | undefined;
    const receive = (value: { windowId: number; trades: RawTrade[] }): void => { packet = value; ctx.authority.emit('change'); };
    bot._client.on('trade_list', receive);
    try {
      ctx.window = await openWindowVerified(bot, entity, { entity: true, expectedTypes: ['minecraft:merchant'], ...ctx.remaining() });
      await ctx.wait(() => packet?.windowId === ctx.window!.id && Array.isArray(packet.trades), 'server villager offers');
      const trades: Trade[] = packet!.trades.map(t => {
        const input1 = Item.fromNotch(t.inputItem1) as ServerItem | null; const output = Item.fromNotch(t.outputItem) as ServerItem | null;
        const input2 = t.inputItem2 ? Item.fromNotch(t.inputItem2) as ServerItem | null : null;
        if (!input1 || !output) throw new Error('Server trade offer is missing its required input or output');
        const demand = Math.max(0, Math.floor(input1.count * (t.demand ?? 0) * (t.priceMultiplier ?? 0)));
        const price = Math.min(Math.max(input1.count + (t.specialPrice ?? 0) + demand, 1), input1.stackSize);
        return { input1, input2, output, price, disabled: !!t.tradeDisabled, maxUses: t.maximumNbTradeUses, uses: t.nbTradeUses };
      });
      sessions.set(bot, { window: ctx.window, trades });
      return { confirmed: true, trades: trades.map((t, index) => ({ index, inputs: [{ ...itemView(t.input1), count: t.price }, itemView(t.input2)], output: itemView(t.output), disabled: t.disabled, maxUses: t.maxUses, uses: t.uses })) };
    } finally { bot._client.removeListener('trade_list', receive); }
  });
}

export async function tradeWithVillagerVerified(bot: Bot, args: WindowOptions & { tradeIndex: number; times?: number }): Promise<Record<string, unknown>> {
  return workflow(bot, args, async ctx => {
    const session = sessions.get(bot); if (!session || session.window !== bot.currentWindow) throw new Error('Open the villager through open_villager to capture fresh server offers');
    ctx.window = session.window;
    const times = args.times ?? 1;
    if (!Number.isInteger(times) || times < 1 || times > 64) throw new Error('Trade times must be 1..64');
    if (!Number.isInteger(args.tradeIndex) || args.tradeIndex < 0) throw new Error('Trade index must be a nonnegative integer');
    const trade = session.trades[args.tradeIndex];
    if (!trade || trade.disabled || trade.maxUses - trade.uses < times) throw new Error('Requested trade is unavailable or exhausted');
    const frame = ctx.frame();
    for (let n = 0; n < times; n++) {
      const before = holdings(ctx, [2]);
      const sequence = ctx.authority.sequence;
      ctx.write('select_trade', { slot: args.tradeIndex });
      await ctx.wait(() => frame.revisions[0] > sequence && frame.revisions[2] > sequence && ctx.authority.same(frame.slots[2], trade.output) && !!frame.slots[0] && ctx.authority.same(frame.slots[0], trade.input1, false) && frame.slots[0]!.count >= trade.price && (!trade.input2 || frame.revisions[1] > sequence && !!frame.slots[1] && ctx.authority.same(frame.slots[1], trade.input2, false) && frame.slots[1]!.count >= trade.input2.count), 'selected trade payment and exact output');
      if (!equalHoldings(before, holdings(ctx, [2]))) throw new Error('Trade selection changed inventory totals unexpectedly');
      adjust(before, ctx.authority, trade.input1, -trade.price); if (trade.input2) adjust(before, ctx.authority, trade.input2, -trade.input2.count); adjust(before, ctx.authority, trade.output, trade.output.count);
      await ctx.move(2, range(frame.inventoryStart, frame.inventoryEnd));
      await ctx.wait(() => ctx.authority.cursor === null && equalHoldings(before, holdings(ctx, [2])), 'exact trade payment consumption and product in inventory');
      trade.uses++;
    }
    await ctx.returnInput(0); await ctx.returnInput(1);
    return { confirmed: true, tradeIndex: args.tradeIndex, times, output: itemView(trade.output), totalReceived: trade.output.count * times, uses: trade.uses, inventory: readWindowVerified(bot) };
  });
}
