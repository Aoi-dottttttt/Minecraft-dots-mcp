// Local guarded adapters of awesome-mineflayer-mcp interaction APIs, pinned at
// 89a407ca18a4a39196c6ebe726d5208cff88a9e5 (MIT, Ryker Geesaman).
// See vendor/awesome-mineflayer-mcp/LICENSE for retained upstream attribution.
import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { equipVerified } from '../verified-inventory.js';
import { getInventoryAuthority } from '../inventory-authority.js';
import {
  activateBlockVerified, dismountVerified, farmBlockVerified, inspectInteractionBlock,
  mountVerified, setBedRespawn, sleepInBedVerified, steerVehicleBounded, stopHeldItem,
  useHeldItemBounded, useItemOnBlockVerified, useOnEntityVerified, wakeVerified,
  type InteractionOptions
} from '../survival-interactions.js';

const point = { x: z.coerce.number().int().finite(), y: z.coerce.number().int().finite(), z: z.coerce.number().int().finite() };
const selection = { itemName: z.string().trim().min(1).optional(), inventorySlot: z.number().int().min(9).max(45).optional().describe('Exact authoritative inventory slot; disambiguates same-name stacks') };
const click = { face: z.enum(['up', 'down', 'north', 'south', 'east', 'west']).optional(), cursor: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), z: z.number().min(0).max(1) }).optional().describe('Local hit coordinates on the selected face') };
const timeout = { timeoutMs: z.number().int().min(1).max(10000).optional() };
const boundedDuration = { durationMs: z.number().int().min(1).max(5000).optional().describe('Always releases controls after this duration; default 1000 ms') };
const entityId = z.number().int().nonnegative();

/** The factory supplies serialization; callers may supply the current action signal. */
export function registerInteractionTools(factory: ToolFactory, getBot: () => Bot, getOptions: () => InteractionOptions = () => ({})): void {
  const response = (value: unknown) => factory.createResponse(JSON.stringify(value));
  factory.registerTool('equip-inventory-slot', 'Equip an exact authoritative inventory stack without substituting an identical hotbar stack',
    { inventorySlot: z.number().int().min(9).max(44), destination: z.enum(['hand', 'head', 'torso', 'legs', 'feet', 'off-hand']).default('hand'), ...timeout },
    async args => {
      const options = getOptions();
      options.signal?.throwIfAborted();
      const bot = getBot();
      const selected = getInventoryAuthority(bot).getFrame(0).slots[args.inventorySlot];
      await equipVerified(bot, args.inventorySlot, args.destination, args.timeoutMs, { exactSource: true, signal: options.signal });
      options.signal?.throwIfAborted();
      return response({ requestIssued: true, confirmed: args.destination !== 'hand', itemName: selected?.name, sourceSlot: args.inventorySlot, destination: args.destination,
        evidence: ['server-confirmed inventory contents'], detail: args.destination === 'hand' ? 'Exact stack inventory verified; hotbar selection is locally selected and sent without a protocol acknowledgement' : 'Exact equipment transfer confirmed by the server' });
    });
  factory.registerTool('inspect-block-properties', 'Inspect a loaded block and its state properties, including open/powered/crop age', point,
    async args => response(inspectInteractionBlock(getBot(), args)));
  factory.registerTool('activate-block', 'Open/close wooden doors, trapdoors and fence gates, or activate buttons/levers. Requires server block-state evidence; never digs a door',
    { ...point, ...click, ...timeout, desiredState: z.enum(['open', 'closed', 'on', 'off']).optional() },
    async args => response(await activateBlockVerified(getBot(), args, { ...args, ...getOptions() })));
  factory.registerTool('use-item-on-block', 'Right-click a block face with the selected main-hand item. Supply expected block state for verified effect; otherwise reports only request sent',
    { ...point, ...selection, ...click, ...timeout, expect: z.object({ position: z.object(point).optional(), name: z.string().min(1).optional(), properties: z.record(z.union([z.string(), z.number().finite(), z.boolean()])).optional() }).optional() },
    async args => response(await useItemOnBlockVerified(getBot(), args, { ...args, ...getOptions() })));
  factory.registerTool('use-held-item', 'Start using the main-hand or off-hand item for a bounded duration and always release it; server inventory evidence is reported separately',
    { ...selection, ...timeout, ...boundedDuration, offHand: z.boolean().optional() },
    async args => response(await useHeldItemBounded(getBot(), { ...args, ...getOptions() })));
  factory.registerTool('stop-using-item', 'Release held-item use; request issuance is distinct from server effect confirmation', {},
    async () => response(stopHeldItem(getBot())));
  factory.registerTool('sleep-in-bed', 'Sleep in a reachable Overworld bed and wait for server-derived sleep evidence', { ...point, ...timeout },
    async args => response(await sleepInBedVerified(getBot(), args, { ...args, ...getOptions() })));
  factory.registerTool('wake-up', 'Wake and wait for server-derived confirmation', timeout,
    async args => response(await wakeVerified(getBot(), { ...args, ...getOptions() })));
  factory.registerTool('set-bed-respawn', 'Interact with an Overworld bed, including daytime. Reports attempted versus server-confirmed respawn change', { ...point, ...timeout },
    async args => response(await setBedRespawn(getBot(), args, { ...args, ...getOptions() })));
  factory.registerTool('farm-block', 'Plant seeds on support soil, till with a hoe, bonemeal, or collect/place a bucket. Verifies resulting blocks, including seeds-to-crop names',
    { ...point, ...selection, ...click, ...timeout, action: z.enum(['plant', 'till', 'bonemeal', 'bucket']) },
    async args => response(await farmBlockVerified(getBot(), args, { ...args, ...getOptions() })));
  factory.registerTool('use-item-on-animal', 'Use a selected item on a nearby animal. Reports server status/inventory evidence without assuming breeding or successful taming; excludes players',
    { ...selection, ...timeout, entityId },
    async args => response(await useOnEntityVerified(getBot(), args.entityId, { ...args, ...getOptions() })));
  factory.registerTool('mount-entity', 'Mount a nearby rideable entity and require server passenger/attachment evidence', { entityId, ...timeout },
    async args => response(await mountVerified(getBot(), args.entityId, { ...args, ...getOptions() })));
  factory.registerTool('dismount-vehicle', 'Dismount and wait for a server passenger/attachment update', timeout,
    async args => response(await dismountVerified(getBot(), { ...args, ...getOptions() })));
  factory.registerTool('steer-vehicle', 'Send bounded vehicle steering, then reset input to zero; reports whether server movement was observed',
    { left: z.number().min(-1).max(1), forward: z.number().min(-1).max(1), ...boundedDuration },
    async args => response(await steerVehicleBounded(getBot(), { ...args, ...getOptions() })));
}
