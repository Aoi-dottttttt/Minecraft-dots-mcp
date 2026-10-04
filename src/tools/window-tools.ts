// Hardened container/workstation routes corresponding to awesome-mineflayer-mcp's pinned tools.
import { z } from 'zod';
import { Vec3 } from 'vec3';
import type mineflayer from 'mineflayer';
import type { WindowOptions } from '../verified-window-actions.js';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';
import { clickWindowVerified, closeWindowVerified, furnaceActionVerified, FURNACE_WINDOW_TYPES, openWindowVerified, readFurnaceVerified, readWindowVerified, selectWindowOptionVerified, STORAGE_WINDOW_TYPES, transferWindowVerified } from '../verified-window-actions.js';

const coordinates = { x: z.coerce.number(), y: z.coerce.number(), z: z.coerce.number() };
const timeoutMs = z.number().int().min(1).max(120000).optional();
const slots = z.array(z.number().int().min(0)).min(1).max(90);
export function registerWindowTools(factory: ToolFactory, getBot: () => mineflayer.Bot, getOptions: () => WindowOptions = () => ({})): void {
  const response = (value: unknown) => factory.createResponse(JSON.stringify(value));
  for (const [name, types] of [['open-container', STORAGE_WINDOW_TYPES], ['open-furnace', FURNACE_WINDOW_TYPES], ['open-workstation', undefined]] as const) {
    factory.registerTool(name, 'Open an in-reach block window and read fresh server-authoritative contents', { ...coordinates, timeoutMs }, async (args) => {
      const bot = getBot(); const p = coerceCoordinates(args.x, args.y, args.z); const block = bot.blockAt(new Vec3(p.x, p.y, p.z));
      if (!block) throw new Error('No loaded block at the requested coordinates');
      await openWindowVerified(bot, block, { expectedTypes: types ? [...types] : undefined, timeoutMs: args.timeoutMs, ...getOptions() });
      return response(readWindowVerified(bot));
    });
  }
  factory.registerTool('read-open-container', 'Read exact server window type, slot indices, player mapping and cursor', {}, async () => response(readWindowVerified(getBot())));
  factory.registerTool('close-window', 'Close a window only with an empty server-confirmed cursor; close has no server acknowledgement', {}, async () => response(await closeWindowVerified(getBot())));
  factory.registerTool('furnace-status', 'Read server furnace input, fuel, output and available progress properties', {}, async () => response(readFurnaceVerified(getBot())));
  factory.registerTool('furnace-action', 'Put or take an exact count in the open furnace using verified slot/cursor transfers', { slot: z.enum(['input', 'fuel', 'output']), op: z.enum(['put', 'take']), itemName: z.string().trim().min(1).optional(), itemType: z.number().int().min(0).optional(), count: z.number().int().positive().optional(), timeoutMs }, async args => response(await furnaceActionVerified(getBot(), { ...args, ...getOptions() })));
  for (const operation of ['deposit', 'withdraw'] as const) {
    factory.registerTool(`container-${operation}`, 'Transfer exact items in an open storage container with server-confirmed source, destination and cursor', { itemName: z.string().trim().min(1), count: z.number().int().positive().optional(), timeoutMs }, async args => {
      const bot = getBot(); const window = readWindowVerified(bot);
      if (!window.layout.storage || !bot.currentWindow) throw new Error('Open a supported storage container first');
      const player = window.slots.filter(s => s.slot >= window.inventoryStart && s.slot < window.inventoryEnd).map(s => s.slot);
      return response(await transferWindowVerified(bot, { ...args, ...getOptions(), sourceSlots: operation === 'deposit' ? player : window.layout.containerSlots, destinationSlots: operation === 'deposit' ? window.layout.containerSlots : player }));
    });
  }
  factory.registerTool('transfer-window-items', 'Move exact items between explicit slot sets in the current window or player inventory; never drops overflow', { sourceSlots: slots, destinationSlots: slots, itemName: z.string().trim().min(1).optional(), itemType: z.number().int().min(0).optional(), count: z.number().int().positive().optional(), timeoutMs }, async args => response(await transferWindowVerified(getBot(), { ...args, ...getOptions() })));
  factory.registerTool('click-window', 'Verified left/right pickup click in the current window; only ordinary mode 0 is supported', { slot: z.number().int().min(0), mouseButton: z.union([z.literal(0), z.literal(1)]).optional(), timeoutMs }, async args => response(await clickWindowVerified(getBot(), { ...args, ...getOptions() })));
  factory.registerTool('select-window-option', 'Select a stonecutter recipe or loom pattern by index, confirming the server-selected option and output', { option: z.number().int().min(0).max(255), timeoutMs }, async args => response(await selectWindowOptionVerified(getBot(), args.option, { ...args, ...getOptions() })));
}
