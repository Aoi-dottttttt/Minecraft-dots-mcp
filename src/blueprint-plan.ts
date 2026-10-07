import { z } from 'zod';
import { Vec3 } from 'vec3';
import { Schematic } from 'prismarine-schematic';
import type { Position, WorkflowStep } from './bounded-workflows.js';

export const positionSchema = z.object({ x: z.number().int().min(-29999984).max(29999984), y: z.number().int().min(-64).max(319), z: z.number().int().min(-29999984).max(29999984) }).strict();
const smallVector = z.object({ x: z.number().int().min(-16).max(16), y: z.number().int().min(-16).max(16), z: z.number().int().min(-16).max(16) }).strict();
export const schematicSchema = z.object({
  version: z.literal('1.21.1'),
  size: z.object({ x: z.number().int().min(1).max(16), y: z.number().int().min(1).max(16), z: z.number().int().min(1).max(16) }).strict(),
  offset: smallVector,
  palette: z.array(z.number().int().min(0).max(100000)).min(1).max(128),
  blocks: z.array(z.number().int().min(0).max(127)).min(1).max(512),
}).strict().superRefine((value, ctx) => {
  const volume = value.size.x * value.size.y * value.size.z;
  if (volume > 512 || volume !== value.blocks.length) ctx.addIssue({ code: 'custom', message: 'Schematic volume must equal blocks length and be at most 512' });
  if (value.blocks.some(index => index >= value.palette.length)) ctx.addIssue({ code: 'custom', message: 'Invalid palette index' });
});
export type BlueprintInput = z.infer<typeof schematicSchema>;
export type ObservedBlock = { name: string; stateId: number; boundingBox?: string };
export type BlueprintWorld = {
  position: Position;
  blockAt(position: Position): ObservedBlock | null;
  knownState(stateId: number): { name: string; minStateId: number; maxStateId: number } | undefined;
  count(item: string): number;
};
const air = new Set(['air', 'cave_air', 'void_air']);
const SIMPLE_BLOCK = /^(stone|cobblestone|mossy_cobblestone|deepslate|cobbled_deepslate|granite|diorite|andesite|polished_granite|polished_diorite|polished_andesite|bricks|stone_bricks|mossy_stone_bricks|cracked_stone_bricks|end_stone|end_stone_bricks|netherrack|nether_bricks|red_nether_bricks|blackstone|polished_blackstone|polished_blackstone_bricks|quartz_block|smooth_quartz|smooth_stone|sandstone|smooth_sandstone|red_sandstone|smooth_red_sandstone|glass|tinted_glass|terracotta|[a-z_]+_planks|[a-z_]+_concrete|[a-z_]+_wool|[a-z_]+_stained_glass|[a-z_]+_terracotta)$/;
const neighbours = [{ x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }];
const key = (position: Position): string => `${position.x},${position.y},${position.z}`;

/** Dry-run only. Air never means demolition. Unknown and conflicting cells block execution. */
export function planBlueprint(input: unknown, originInput: unknown, world: BlueprintWorld): {
  executable: boolean; steps: WorkflowStep[]; materials: Array<{ item: string; required: number; available: number; missing: number }>;
  blockers: Array<{ position: Position; reason: string }>; alreadyPresent: number; ignoredAir: number;
} {
  const data = schematicSchema.parse(input), origin = positionSchema.parse(originInput);
  for (const stateId of data.palette) if (!world.knownState(stateId)) throw Error(`Unknown block state ${stateId}`);
  const schematic = Schematic.fromJSON(JSON.stringify(data));
  const pending: Array<Extract<WorkflowStep, { kind: 'place' }>> = [];
  const blockers: Array<{ position: Position; reason: string }> = [];
  let alreadyPresent = 0, ignoredAir = 0;
  for (let y = 0; y < data.size.y; y++) for (let z = 0; z < data.size.z; z++) for (let x = 0; x < data.size.x; x++) {
    const relative = new Vec3(x + data.offset.x, y + data.offset.y, z + data.offset.z);
    const stateId = schematic.getBlockStateId(relative), desired = world.knownState(stateId)!;
    if (air.has(desired.name)) { ignoredAir++; continue; }
    const position = positionSchema.parse({ x: origin.x + relative.x, y: origin.y + relative.y, z: origin.z + relative.z });
    if (new Vec3(world.position.x, world.position.y, world.position.z).distanceTo(new Vec3(position.x, position.y, position.z)) > 64) throw Error('Blueprint must stay within 64 blocks of the current player');
    if (!SIMPLE_BLOCK.test(desired.name) || desired.minStateId !== desired.maxStateId) {
      blockers.push({ position, reason: `Unsupported block/state: ${desired.name}; only simple non-directional solid blocks are supported` }); continue;
    }
    const current = world.blockAt(position);
    if (!current) { blockers.push({ position, reason: 'Chunk is not loaded' }); continue; }
    if (current.stateId === stateId) { alreadyPresent++; continue; }
    if (!air.has(current.name)) { blockers.push({ position, reason: `Occupied by ${current.name}; removal and replacement are forbidden` }); continue; }
    pending.push({ kind: 'place', position, item: desired.name, stateId });
  }
  const totals = new Map<string, number>();
  for (const step of pending) totals.set(step.item, (totals.get(step.item) ?? 0) + 1);
  const materials = [...totals].map(([item, required]) => { const available = world.count(item); return { item, required, available, missing: Math.max(0, required - available) }; });
  const steps: WorkflowStep[] = [], planned = new Set<string>();
  while (pending.length) {
    const index = pending.findIndex(step => neighbours.some(delta => {
      const position = { x: step.position.x + delta.x, y: step.position.y + delta.y, z: step.position.z + delta.z };
      return planned.has(key(position)) || world.blockAt(position)?.boundingBox === 'block';
    }));
    if (index < 0) { for (const step of pending) blockers.push({ position: step.position, reason: 'No observed solid support or previously planned neighbour' }); break; }
    const step = pending.splice(index, 1)[0]; planned.add(key(step.position)); steps.push(step);
  }
  return { executable: blockers.length === 0 && materials.every(item => item.missing === 0), steps, materials, blockers, alreadyPresent, ignoredAir };
}
