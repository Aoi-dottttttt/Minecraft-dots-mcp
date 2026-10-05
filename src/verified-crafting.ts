// Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
import type mineflayer from 'mineflayer';
import { getInventoryAuthority, type InventoryFrame, type ServerItem } from './inventory-authority.js';

type Ingredient = { id: number; metadata?: number | null; count?: number };
export type VerifiedRecipe = { result: Ingredient & { count: number }; requiresTable?: boolean; inShape?: Ingredient[][] | null; ingredients?: Ingredient[] | null; outShape?: Ingredient[][] | null };
type Placement = { slot: number; ingredient: Ingredient };
const matches = (item: ServerItem | null, ingredient: Ingredient) => !!item && item.type === ingredient.id && (ingredient.metadata == null || item.metadata === ingredient.metadata);

/** Craft using actual server slot/cursor packets. Mineflayer craft() is intentionally not used. */
export async function craftVerified(bot: mineflayer.Bot, recipe: VerifiedRecipe, table?: Parameters<mineflayer.Bot['craft']>[2], timeoutMs = 5000, options: { signal?: AbortSignal } = {}): Promise<{ outputCount: number; itemName: string }> {
  const authority = getInventoryAuthority(bot);
  options.signal?.throwIfAborted();
  authority.assertMutationReady();
  if (!bot.supportFeature('stateIdUsed') || bot.registry.version.version !== 767) throw new Error('Verified crafting currently requires Java 1.21.1 / protocol 767; other click formats have not been validated');
  if (bot.currentWindow) throw new Error('Close the current container before crafting');
  if (authority.cursor) throw new Error('Cursor is holding an item; crafting will not overwrite or drop it');
  if (!Number.isInteger(recipe.result?.id) || !Number.isInteger(recipe.result?.count) || recipe.result.count < 1) throw new Error('Invalid resolved recipe result');
  if (recipe.requiresTable && !table) throw new Error('Recipe requires an in-reach crafting table');
  const width = table ? 3 : 2;
  const placements = recipePlacements(recipe, width);
  if (!placements.length) throw new Error('Recipe has no supported ingredients');
  const before = authority.items();
  const deltas = new Map<string, number>();
  const itemKey = (item: ServerItem) => authority.identity(item);
  const addDelta = (item: ServerItem, count: number) => { const key = itemKey(item); deltas.set(key, (deltas.get(key) ?? 0) + count); };
  // Keep enough recovery space for output and each crafting remainder. Never toss overflow.
  const expectedRemainders = new Map<number, Ingredient>();
  if (recipe.outShape) {
    for (let y = 0; y < recipe.outShape.length; y++) for (let x = 0; x < recipe.outShape[y].length; x++) {
      const item = recipe.outShape[y][x];
      if (item.id >= 0) expectedRemainders.set(1 + x + width * y, item);
    }
  } else {
    // minecraft-data omits Vanilla crafting remainders for these container items.
    const remainderNames: Record<string, string> = { milk_bucket: 'bucket', water_bucket: 'bucket', lava_bucket: 'bucket', powder_snow_bucket: 'bucket', honey_bottle: 'glass_bottle', dragon_breath: 'glass_bottle' };
    for (const { slot, ingredient } of placements) {
      const name = bot.registry.items[ingredient.id]?.name;
      const remainderName = remainderNames[name];
      if (remainderName) expectedRemainders.set(slot, { id: bot.registry.itemsByName[remainderName].id, count: 1 });
    }
  }
  const remainderSlots = expectedRemainders.size;
  const free = 36 - before.length;
  if (free < 1 + remainderSlots) throw new Error(`Verified crafting needs ${1 + remainderSlots} empty inventory slot(s) for safe output and remainder recovery; found ${free}`);
  assertMaterials(before, placements);
  let frame: InventoryFrame = authority.getFrame(0);
  let opened = false;
  let mutationStarted = false;
  let resultTaken = false;
  let outputBoundary = 0;
  const deadline = Date.now() + 90_000;
  const wait = (predicate: () => boolean, description: string) => authority.waitFor(() => { options.signal?.throwIfAborted(); return predicate(); }, Math.max(1, Math.min(timeoutMs, deadline - Date.now())), description, options.signal);
  const click = async (slot: number, button: number, expected: () => boolean, description: string) => {
    options.signal?.throwIfAborted();
    authority.assertMutationReady();
    if (Date.now() >= deadline) throw new Error('Craft action deadline reached before the next click');
    if ((bot.currentWindow?.id ?? 0) !== frame.id) throw new Error('Crafting window changed unexpectedly');
    const sequence = authority.sequence;
    const cursorBefore = authority.cursor;
    // No local prediction. Sending pre-click cursor and no predicted changed slots makes
    // Vanilla broadcast authoritative corrections. The tracked state ID is per window.
    mutationStarted = true;
    try { bot._client.write('window_click', { windowId: frame.id, stateId: frame.stateId, slot, mouseButton: button, mode: 0, changedSlots: [], cursorItem: authority.raw(cursorBefore) });
      await wait(() => authority.sequence > sequence && expected(), description);
      options.signal?.throwIfAborted(); }
    catch (error) {
      authority.block(`Unconfirmed inventory click (${description}); materials may be on the cursor or crafting grid`);
      throw error;
    }
  };
  const destination = (item: ServerItem): number => {
    for (let slot = frame.inventoryStart; slot < frame.inventoryEnd; slot++) {
      const current = frame.slots[slot];
      if (current && authority.same(current, item, false) && current.count + item.count <= current.stackSize) return slot;
    }
    for (let slot = frame.inventoryStart; slot < frame.inventoryEnd; slot++) if (!frame.slots[slot]) return slot;
    throw new Error('No safe inventory destination; item retained instead of dropped');
  };
  const storeCursor = async () => {
    if (!authority.cursor) return;
    const item = authority.cursor;
    const slot = destination(item);
    const count = (frame.slots[slot]?.count ?? 0) + item.count;
    await click(slot, 0, () => authority.cursor === null && matches(frame.slots[slot], { id: item.type, metadata: item.metadata }) && frame.slots[slot]!.count === count, 'return cursor to inventory');
  };
  const recoverGrid = async () => {
    await storeCursor();
    for (let slot = 1; slot <= width * width; slot++) {
      const item = frame.slots[slot];
      if (!item) continue;
      await click(slot, 0, () => frame.slots[slot] === null && authority.same(authority.cursor, item), 'recover crafting input or remainder');
      await storeCursor();
    }
  };

  try {
    options.signal?.throwIfAborted();
    if (table) {
      const position = table.position;
      if (!position || position.distanceTo(bot.entity.position) > 4.5) throw new Error('Crafting table is outside safe interaction reach (4.5 blocks); no interaction or inventory click was sent');
      // Re-read the loaded world before activation. Nearby-by-distance can select
      // a table behind a wall; rejecting here leaves the ordinary action lane usable.
      const currentTable = bot.blockAt(position);
      if (!currentTable || currentTable.name !== 'crafting_table') throw new Error('Crafting table is no longer loaded at the target; no interaction or inventory click was sent');
      if (!bot.canSeeBlock(currentTable)) throw new Error('Crafting table is not visible; move to a clear line of sight first. No interaction or inventory click was sent');
      if (bot.getControlState('sneak')) throw new Error('Stop sneaking before opening a crafting table; no interaction or inventory click was sent');
      const seq = authority.sequence;
      const windowPromise = wait(() => !!bot.currentWindow && String(bot.currentWindow.type).startsWith('minecraft:crafting') && !!authority.frames.get(bot.currentWindow.id)?.fullRevision && authority.frames.get(bot.currentWindow.id)!.fullRevision > seq, 'open crafting table with authoritative contents');
      // The confirmation timer may expire while activateBlock is still awaiting
      // lookAt. Consume rejection immediately, but still await activation itself:
      // releasing the lane early could permit its eventual packet to race a new action.
      void windowPromise.catch(() => {});
      try { options.signal?.throwIfAborted(); await bot.activateBlock(currentTable); await windowPromise; options.signal?.throwIfAborted(); }
      catch (error) { authority.block('Crafting-table opening request was not confirmed; no inventory click was sent, but a late window may still arrive'); throw error; }
      frame = authority.getFrame(bot.currentWindow!.id);
      opened = true;
    }
    if (frame.slots.slice(0, width * width + 1).some(Boolean)) throw new Error('Crafting grid or output is already occupied; refusing to consume unfamiliar contents');
    for (const { slot, ingredient } of placements) {
      const source = frame.slots.findIndex((item, i) => i >= frame.inventoryStart && i < frame.inventoryEnd && matches(item, ingredient));
      if (source < 0) throw new Error('An ingredient disappeared before placement');
      const stack = frame.slots[source]!;
      await click(source, 0, () => frame.slots[source] === null && authority.same(authority.cursor, stack), 'pick up ingredient');
      outputBoundary = authority.sequence;
      await click(slot, 1, () => matches(frame.slots[slot], ingredient) && frame.slots[slot]!.count === 1 && (stack.count === 1 ? authority.cursor === null : matches(authority.cursor, ingredient) && authority.cursor!.count === stack.count - 1), 'place one ingredient');
      addDelta(stack, -1);
      // Returning to the known source avoids consuming a free output slot.
      if (authority.cursor) {
        const rest = authority.cursor;
        await click(source, 0, () => authority.cursor === null && authority.same(frame.slots[source], rest), 'return unused ingredient stack');
      }
    }
    await wait(() => frame.revisions[0] > outputBoundary && matches(frame.slots[0], recipe.result) && frame.slots[0]!.count === recipe.result.count, 'server-generated recipe output');
    const result = frame.slots[0]!;
    await click(0, 0, () => authority.same(authority.cursor, result) && frame.slots[0] === null, 'take server-generated crafting result');
    resultTaken = true;
    addDelta(result, result.count);
    await wait(() => Array.from({ length: width * width }, (_, i) => i + 1).every(slot => {
      const expected = expectedRemainders.get(slot);
      return expected ? matches(frame.slots[slot], expected) && frame.slots[slot]!.count === (expected.count ?? 1) : frame.slots[slot] === null;
    }), 'consumed ingredients and recipe remainders');
    for (const slot of expectedRemainders.keys()) addDelta(frame.slots[slot]!, frame.slots[slot]!.count);
    await storeCursor();
    await recoverGrid();
    if (authority.cursor || frame.slots.slice(1, width * width + 1).some(Boolean)) throw new Error('Crafting cleanup is incomplete');
    verifyDeltas(before, authority.items(), deltas, itemKey);
    options.signal?.throwIfAborted();
    if (opened) bot.closeWindow(bot.currentWindow!);
    return { outputCount: recipe.result.count, itemName: result.name };
  } catch (error) {
    let recovery = '';
    // Cancellation revokes permission for every subsequent click, including
    // recovery. Keep already-submitted inventory changes visible and fenced.
    if (options.signal?.aborted && mutationStarted) authority.block('Crafting was cancelled after an inventory click; do not recover or repeat automatically');
    if (!authority.fence && mutationStarted && !resultTaken) {
      try { await recoverGrid(); verifyDeltas(before, authority.items(), new Map(), itemKey); recovery = '; all input materials recovered'; }
      catch (cleanupError) { authority.block(`Craft cleanup was not confirmed: ${(cleanupError as Error).message}`); recovery = '; recovery uncertain; further actions locked'; }
    } else if (resultTaken && !authority.fence) {
      authority.block('Craft result was taken but complete inventory conservation was not confirmed');
    }
    if (opened && !authority.fence && authority.cursor === null) bot.closeWindow(bot.currentWindow!);
    throw new Error(`${error instanceof Error ? error.message : String(error)}${recovery}${authority.fence ? '; inventory safety lock active, do not repeat the craft' : ''}`);
  }
}

function recipePlacements(recipe: VerifiedRecipe, width: number): Placement[] {
  const result: Placement[] = [];
  for (let y = 0; y < (recipe.inShape?.length ?? 0); y++) {
    const row = recipe.inShape![y];
    if (y >= width || row.length > width) throw new Error('Recipe exceeds this crafting grid');
    for (let x = 0; x < row.length; x++) if (row[x].id >= 0) result.push({ slot: 1 + x + width * y, ingredient: row[x] });
  }
  for (const ingredient of recipe.ingredients ?? []) {
    if (ingredient.id < 0) continue;
    const slot = Array.from({ length: width * width }, (_, i) => i + 1).find(s => !result.some(p => p.slot === s));
    if (!slot) throw new Error('Too many shapeless ingredients for this crafting grid');
    result.push({ slot, ingredient });
  }
  return result;
}
function assertMaterials(items: Array<ServerItem>, placements: Placement[]): void {
  const remaining = items.map(item => ({ ...item }));
  for (const { ingredient } of placements) {
    const item = remaining.find(i => i.count > 0 && matches(i, ingredient));
    if (!item) throw new Error(`Missing ingredient item ID ${ingredient.id}`);
    item.count--;
  }
}
function verifyDeltas(before: ServerItem[], after: ServerItem[], expected: Map<string, number>, key: (item: ServerItem) => string): void {
  const actual = new Map<string, number>();
  for (const item of before) actual.set(key(item), (actual.get(key(item)) ?? 0) - item.count);
  for (const item of after) actual.set(key(item), (actual.get(key(item)) ?? 0) + item.count);
  for (const identity of new Set([...actual.keys(), ...expected.keys()])) {
    if ((actual.get(identity) ?? 0) !== (expected.get(identity) ?? 0)) throw new Error(`Server inventory conservation check failed: expected item delta ${expected.get(identity) ?? 0}, received ${actual.get(identity) ?? 0}`);
  }
}
