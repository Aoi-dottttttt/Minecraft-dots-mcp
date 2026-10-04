// Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
import { z } from "zod";
import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';
import { getInventoryAuthority } from '../inventory-authority.js';
import { chooseExactItem } from '../verified-inventory.js';
import { closeWindowVerified, furnaceActionVerified, FURNACE_WINDOW_TYPES, openWindowVerified } from '../verified-window-actions.js';

const FURNACE_BLOCKS = new Set(['furnace', 'blast_furnace', 'smoker']);

export function registerFurnaceTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "smelt-item",
    "Smelt items using a furnace-like block",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      inputItem: z.string().trim().min(1).describe("Name of item to smelt"),
      inputCount: z.number().int().positive().max(64).optional().describe("Amount of input to smelt (default: 1)"),
      fuelItem: z.string().trim().min(1).describe("Name of fuel item"),
      fuelCount: z.number().int().positive().max(64).optional().describe("Amount of fuel to use (default: 1)"),
      takeOutput: z.boolean().optional().describe("Whether to take output when ready (default: true)"),
      timeoutMs: z.number().int().min(50).max(120000).optional().describe("Timeout waiting for output in ms (default: 60000)")
    },
    async ({
      x,
      y,
      z,
      inputItem,
      inputCount = 1,
      fuelItem,
      fuelCount = 1,
      takeOutput = true,
      timeoutMs = 60000
    }: {
      x: number;
      y: number;
      z: number;
      inputItem: string;
      inputCount?: number;
      fuelItem: string;
      fuelCount?: number;
      takeOutput?: boolean;
      timeoutMs?: number;
    }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();

      const furnacePos = new Vec3(x, y, z);
      const furnaceBlock = bot.blockAt(furnacePos);

      if (!furnaceBlock || !FURNACE_BLOCKS.has(furnaceBlock.name)) {
        return factory.createResponse(`No furnace block found at (${x}, ${y}, ${z})`);
      }

      const authority = getInventoryAuthority(bot);
      authority.assertMutationReady();
      if (bot.currentWindow || authority.cursor) throw new Error('Close the current container and clear the cursor before smelting');
      if (bot.entity.position.distanceTo(furnacePos.offset(0.5, 0.5, 0.5)) > 4.5) throw new Error('Move within 4.5 blocks of the furnace first');
      const items = authority.items();
      if (items.length >= 36 && takeOutput) throw new Error('Keep an empty inventory slot for furnace output; overflow is not dropped');
      const input = chooseExactItem(items, inputItem);
      if (!input) {
        return factory.createResponse(`Couldn't find any item matching '${inputItem}' in inventory`);
      }

      const fuel = chooseExactItem(items, fuelItem);
      if (!fuel) {
        return factory.createResponse(`Couldn't find any fuel item matching '${fuelItem}' in inventory`);
      }

      const resolvedInputCount = inputCount;
      const resolvedFuelCount = fuelCount;
      const availableInput = authority.count(input.type, input.metadata);
      const availableFuel = authority.count(fuel.type, fuel.metadata);
      if (availableInput < inputCount || availableFuel < fuelCount || (input.type === fuel.type && input.metadata === fuel.metadata && availableInput < inputCount + fuelCount)) throw new Error('Not enough authoritative inventory for the requested input and fuel counts combined; no materials deposited');

      const furnace = await openWindowVerified(bot, furnaceBlock, { expectedTypes: FURNACE_WINDOW_TYPES });
      let mutationStarted = false;

      try {
        const frame = authority.getFrame(furnace.id);
        const existingInput = frame.slots[0];
        if (existingInput && existingInput.name !== input.name) {
          return factory.createResponse(`Furnace input slot is occupied by ${existingInput.name}`);
        }

        const existingFuel = frame.slots[1];
        if (existingFuel && existingFuel.name !== fuel.name) {
          return factory.createResponse(`Furnace fuel slot is occupied by ${existingFuel.name}`);
        }

        mutationStarted = true;
        await furnaceActionVerified(bot, { slot: 'fuel', op: 'put', itemType: fuel.type, count: resolvedFuelCount });
        await furnaceActionVerified(bot, { slot: 'input', op: 'put', itemType: input.type, count: resolvedInputCount });

        if (!takeOutput) {
          return factory.createResponse(
            `Server-confirmed furnace deposit: ${resolvedInputCount} ${input.name} and ${resolvedFuelCount} ${fuel.name}; smelting completion is not yet confirmed`
          );
        }

        try {
          await authority.waitFor(() => { if (bot.currentWindow !== furnace || authority.frames.get(furnace.id) !== frame) throw new Error('Furnace window changed while waiting for output'); return !!frame.slots[2]; }, timeoutMs, 'furnace output');
        } catch (error) {
          if (authority.ended || authority.fence || bot.currentWindow !== furnace || !(error instanceof Error) || !error.message.startsWith('Server confirmation timed out:')) throw error;
          return factory.createResponse(`Input and fuel deposits confirmed, but no output after ${timeoutMs}ms. Materials remain in the furnace; do not repeat the deposit to check progress.`);
        }
        const output = frame.slots[2]!;
        await furnaceActionVerified(bot, { slot: 'output', op: 'take', count: output.count });
        return factory.createResponse(`Server-confirmed collection: ${output.count} ${output.name}. This may include previously smelted output; remaining input: ${frame.slots[0]?.count ?? 0}.`);
      } catch (error) {
        if (mutationStarted) authority.block('Furnace transfer was not fully confirmed; inspect inventory and the open furnace before retrying');
        throw error;
      } finally {
        if (!authority.fence && !authority.cursor && bot.currentWindow === furnace) await closeWindowVerified(bot);
      }
    }
  );
}
