/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';
import { z } from 'zod';
import { getInventoryAuthority } from '../inventory-authority.js';
import { equipVerified } from '../verified-inventory.js';
import { openWindowVerified, closeWindowVerified, readWindowVerified, transferWindowVerified, STORAGE_WINDOW_TYPES } from '../verified-window-actions.js';
import { BoundedWorkflows, type Position, type WorkflowStep } from '../bounded-workflows.js';
import { planBlueprint, positionSchema, schematicSchema } from '../blueprint-plan.js';
import { moveAndVerify } from './movement-utils.js';

const name = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const stack = z.object({ item: name, count: z.number().int().min(1).max(256) }).strict();
export const gatherPlanSchema = z.object({
  targets: z.array(z.object({ position: positionSchema, block: name, item: name, minimum: z.number().int().min(1).max(64).default(1) }).strict()).min(1).max(16),
  chest: positionSchema,
  deposit: z.array(stack).min(1).max(16),
  restock: z.array(stack).max(16).default([]),
}).strict();
const range = (start: number, end: number): number[] => Array.from({ length: Math.max(0, end - start) }, (_, i) => i + start);
const json = (value: unknown): any => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const vec = (position: Position): Vec3 => new Vec3(position.x, position.y, position.z);
const air = new Set(['air', 'cave_air', 'void_air']);
// Deliberately narrow: no ores needing specialised tools, crops, gravity blocks,
// logs supporting leaves, fluids, or blocks whose removal causes chained changes.
const GATHER_BLOCKS: Record<string, string> = { dirt: 'dirt', grass_block: 'dirt', stone: 'cobblestone', cobblestone: 'cobblestone', granite: 'granite', diorite: 'diorite', andesite: 'andesite', deepslate: 'cobbled_deepslate', cobbled_deepslate: 'cobbled_deepslate' };

type Options = { bot: Bot; facade: any; factory: any; server: any; markRead(name: string): void;
  runAction<T>(operation: () => Promise<T>): Promise<T>; settings(): { signal?: AbortSignal }; abortAction(): void;
  legacy(name: string, args: any): Promise<any> };

/** Adapts existing verified primitives; never creates another bot/controller. */
export function registerWorkflowTools(options: Options): { names: string[]; cancelAll(): void } {
  const { bot, facade, factory, server } = options;
  const authority = getInventoryAuthority(bot);
  const count = (item: string): number => authority.items().filter(value => value.name === item).reduce((sum, value) => sum + value.count, 0);
  const dimension = (): string => String(bot.game?.dimension ?? 'unknown');
  const dimensions = new Map<string, string>();
  let runningDimension: string | undefined;
  const ready = (signal: AbortSignal): void => {
    signal.throwIfAborted(); authority.assertMutationReady();
    if (dimension() !== runningDimension) throw Error('Workflow dimension changed; create a new plan after inspection');
    if (bot.health < 10 || bot.food < 6) throw Error('Workflow paused by low health or hunger; inspect before a new plan');
  };
  const move = async (position: Position, distance: number, signal: AbortSignal): Promise<void> => {
    ready(signal);
    if (bot.entity.position.distanceTo(vec(position)) > 64) throw Error('Workflow step is outside the 64-block local bound');
    await moveAndVerify(bot, new pathfinder.goals.GoalNear(position.x, position.y, position.z, distance), 15000, { signal });
    ready(signal);
  };
  const executor = async (step: WorkflowStep, signal: AbortSignal): Promise<Record<string, unknown>> => {
    signal.addEventListener('abort', options.abortAction, { once: true });
    try {
      ready(signal);
      if (bot.currentWindow) throw Error('Close the current window before running a workflow step');
      if (step.kind === 'move') { await move(step.position, step.range, signal); return { confirmed: true, position: { ...bot.entity.position } }; }
      if (step.kind === 'gather') {
        const current = bot.blockAt(vec(step.position));
        if (!current || current.name !== step.block) throw Error('Gather target changed or unloaded; no replacement target selected');
        // Refuse liquids, falling blocks and player support before approaching.
        for (const delta of [new Vec3(0, 1, 0), new Vec3(-1, 0, 0), new Vec3(1, 0, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1)]) {
          const neighbour = bot.blockAt(vec(step.position).plus(delta));
          if (!neighbour || /water|lava/.test(neighbour.name) || (delta.y === 1 && /sand|gravel|concrete_powder|anvil/.test(neighbour.name))) throw Error('Gather target has unloaded, fluid or falling-block neighbours');
        }
        if (authority.getFrame(0).slots.slice(9, 45).filter(item => !item).length < 2) throw Error('Gathering requires two empty authoritative inventory slots');
        await move(step.position, 2, signal);
        if (!facade.tool?.equipForBlock) throw Error('Existing mineflayer-tool plugin is unavailable');
        await facade.tool.equipForBlock(current, { requireHarvest: true, getFromChest: false }); ready(signal);
        const before = count(step.item), sequence = authority.sequence;
        if (bot.blockAt(vec(step.position))?.name !== step.block) throw Error('Gather target changed before digging');
        await options.legacy('dig-block', step.position); ready(signal);
        if (!air.has(bot.blockAt(vec(step.position))?.name ?? '')) throw Error('Target removal not confirmed');
        if (count(step.item) < before + step.minimum) await move(step.position, 0, signal);
        await authority.waitFor(() => authority.sequence > sequence && count(step.item) >= before + step.minimum, 5000, 'gathered item increase', signal);
        return { confirmed: true, blockRemoved: step.block, item: step.item, observedInventoryIncrease: count(step.item) - before, inventorySequence: authority.sequence, note: 'Increase is server-observed; nearby pickups cannot be attributed uniquely to this block' };
      }
      if (step.kind === 'place') {
        const current = bot.blockAt(vec(step.position));
        if (!current) throw Error('Placement target unloaded');
        if (current.stateId === step.stateId) return { confirmed: true, alreadyPresent: true, requestIssued: false };
        if (!air.has(current.name)) throw Error('Placement target is occupied; workflow never clears or replaces blocks');
        await move(step.position, 3, signal);
        const items = authority.items().filter(item => item.name === step.item);
        if (!items.length) throw Error('Blueprint material is missing');
        const slot = items[0].slot;
        await equipVerified(bot, slot, 'hand', 5000, { exactSource: true, signal }); ready(signal);
        if (authority.getFrame(0).slots[36 + bot.quickBarSlot]?.name !== step.item) throw Error('Blueprint material changed after equipping');
        const before = count(step.item), sequence = authority.sequence;
        await options.legacy('place-block', step.position); ready(signal);
        await authority.waitFor(() => authority.sequence > sequence && count(step.item) === before - 1, 5000, 'exact blueprint material consumption', signal);
        if (bot.blockAt(vec(step.position))?.stateId !== step.stateId) throw Error('Exact blueprint block state was not observed');
        return { confirmed: true, stateId: step.stateId, consumed: 1, inventorySequence: authority.sequence };
      }
      await move(step.position, 3, signal);
      const block = bot.blockAt(vec(step.position));
      if (!block || !['chest', 'trapped_chest', 'barrel'].includes(block.name)) throw Error('Only the explicitly selected chest/barrel is supported');
      await openWindowVerified(bot, block, { expectedTypes: STORAGE_WINDOW_TYPES, timeoutMs: 5000, signal }); ready(signal);
      const window = readWindowVerified(bot);
      const deposit = step.kind === 'deposit';
      const result = await transferWindowVerified(bot, { sourceSlots: range(deposit ? window.inventoryStart : 0, deposit ? window.inventoryEnd : window.inventoryStart), destinationSlots: range(deposit ? 0 : window.inventoryStart, deposit ? window.inventoryStart : window.inventoryEnd), itemName: step.item, count: step.count, signal, timeoutMs: 5000 });
      ready(signal); await closeWindowVerified(bot);
      return { confirmed: result.transferred === step.count, item: step.item, transferred: result.transferred, inventorySequence: authority.sequence };
    } finally { signal.removeEventListener('abort', options.abortAction); }
  };
  const workflows = new BoundedWorkflows(executor);
  const names: string[] = [];
  const readTool = (tool: string, description: string, schema: any, handler: (args: any) => Promise<any>): void => {
    options.markRead(tool); factory.registerTool(tool, description, schema, handler); names.push(tool);
  };
  readTool('plan-gather-workflow', 'Plan one bounded cycle: explicit terrain targets, return to the selected storage, exact deposit, exact restock. Planning performs no game actions; inspect the returned steps before running.', gatherPlanSchema.shape, async input => {
    const args = gatherPlanSchema.parse(input);
    if (bot.currentWindow) throw Error('Close the current window before planning');
    const seen = new Set<string>();
    for (const target of args.targets) {
      if (GATHER_BLOCKS[target.block] !== target.item) throw Error('Unsupported gather block/drop pair; this first stage supports only simple terrain');
      if (target.minimum !== 1) throw Error('Simple terrain gathering expects one item per target');
      const key = JSON.stringify(target.position); if (seen.has(key)) throw Error('Duplicate gather target'); seen.add(key);
      if (bot.entity.position.distanceTo(vec(target.position)) > 32) throw Error('Gather targets must be within 32 blocks');
      if (bot.blockAt(vec(target.position))?.name !== target.block) throw Error('Gather target must match a loaded observed block');
    }
    if (bot.entity.position.distanceTo(vec(args.chest)) > 64 || !['chest', 'trapped_chest', 'barrel'].includes(bot.blockAt(vec(args.chest))?.name ?? '')) throw Error('Selected storage must be observed within 64 blocks');
    for (const entry of [...args.deposit, ...args.restock]) if (!bot.registry.itemsByName[entry.item]) throw Error('Unknown deposit/restock item');
    const actions: WorkflowStep[] = [...args.targets.map(target => ({ kind: 'gather' as const, ...target })), { kind: 'move', position: args.chest, range: 3 }, ...args.deposit.map(entry => ({ kind: 'deposit' as const, position: args.chest, ...entry })), ...args.restock.map(entry => ({ kind: 'withdraw' as const, position: args.chest, ...entry }))];
    const plan = workflows.create('gather', actions); dimensions.set(plan.id, dimension());
    return json({ ...plan, note: 'One cycle only. No background repetition, automatic crafting, inferred ownership or automatic retry. Storage capacity and stock are rechecked when opened.' });
  });
  readTool('plan-blueprint-workflow', 'Import bounded prismarine-schematic JSON for Java 1.21.1, inspect materials/support/conflicts, and prepare survival placement steps. Air never requests demolition. No binary files, NBT, entities, commands, or network fetches.', { schematic: schematicSchema, origin: positionSchema }, async args => {
    const plan = planBlueprint(args.schematic, args.origin, { position: bot.entity.position, blockAt: position => bot.blockAt(vec(position)), knownState: stateId => bot.registry.blocksByStateId[stateId], count });
    if (!plan.executable || !plan.steps.length) return json({ ...plan, workflow: null });
    const workflow = workflows.create('blueprint', plan.steps); dimensions.set(workflow.id, dimension());
    return json({ ...plan, workflow });
  });
  server.tool('read-workflow', 'Read this backend session’s exact workflow progress and submitted-step evidence. Reading never resumes or replays actions.', { id: z.string().uuid() }, async (args: any) => json(workflows.snapshot(z.string().uuid().parse(args.id))));
  options.markRead('read-workflow'); names.push('read-workflow');
  factory.registerTool('run-workflow', 'Execute at most four prepared steps in the existing single action lane, with cancellation and a 90-second batch deadline. Supply the observed revision. Failed/cancelled/submitted steps are never retried.', { id: z.string().uuid(), expectedRevision: z.number().int().min(0), maxSteps: z.number().int().min(1).max(4).default(1) }, async (args: any) => options.runAction(async () => {
    runningDimension = dimensions.get(args.id);
    try { return json(await workflows.run(args.id, args.expectedRevision, args.maxSteps, options.settings().signal)); }
    finally { runningDimension = undefined; }
  })); names.push('run-workflow');
  // A stop must bypass the queued action so it can interrupt it. Only the active
  // workflow owns its controller; cancelling a prepared plan touches no controls.
  server.tool('cancel-workflow', 'Cancel one prepared or running workflow. Submitted work drains before another action starts; nothing is rolled back or replayed.', { id: z.string().uuid() }, async (args: any) => json(workflows.cancel(z.string().uuid().parse(args.id))));
  options.markRead('cancel-workflow'); names.push('cancel-workflow');
  return { names, cancelAll: () => workflows.cancelAll() };
}
