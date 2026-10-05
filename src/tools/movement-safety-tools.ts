import type { Bot } from 'mineflayer';
import { z } from 'zod';
import type { ToolFactory } from '../tool-factory.js';
import { inspectMovementSafety, surfaceFromWater } from '../movement-safety.js';
import { launchBoatVerified } from '../verified-boat.js';
import type { InteractionOptions } from '../survival-interactions.js';

export function registerMovementSafetyTools(factory: ToolFactory, getBot: () => Bot, getOptions: () => InteractionOptions): void {
  const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  factory.registerTool('inspect-movement-safety', 'Read oxygen, dry-route hazards and the bounded vertical escape column without moving. Loaded observations do not establish a safe shore route.', {},
    async () => json(inspectMovementSafety(getBot())));
  factory.registerTool('surface-from-water', 'Explicitly attempt a bounded vertical escape through a loaded clear source-water column. Release all controls on every exit; never resume a route or retry. Fresh breath evidence is required, and dry land is not confirmed.', {
    timeoutMs: z.number().int().min(1).max(8000).default(5000), maxRise: z.number().int().min(1).max(8).default(6)
  }, async args => json(await surfaceFromWater(getBot(), { ...getOptions(), ...args })));
  factory.registerTool('launch-boat', 'Use one ordinary boat/raft on an inspected source-water patch; require exact server inventory debit and one fresh nearby boat before optional mounting. No automatic driving, retry or landing. Real-server boat physics remains unvalidated.', {
    x: z.number().int(), y: z.number().int(), z: z.number().int(),
    itemName: z.string().optional(), inventorySlot: z.number().int().min(9).max(44).optional(),
    mount: z.boolean().default(false), timeoutMs: z.number().int().min(1).max(10000).default(5000)
  }, async args => json(await launchBoatVerified(getBot(), args, { ...getOptions(), ...args })));
}
