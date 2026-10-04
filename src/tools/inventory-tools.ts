// Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
import { z } from "zod";
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { getInventoryAuthority } from '../inventory-authority.js';
import { chooseExactItem, equipVerified } from '../verified-inventory.js';

interface InventoryItem {
  name: string;
  count: number;
  slot: number;
}

export function registerInventoryTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "list-inventory",
    "List all items in the bot's inventory",
    {},
    async () => {
      const bot = getBot();
      const items = getInventoryAuthority(bot).items();
      const itemList: InventoryItem[] = items.map((item) => ({
        name: item.name,
        count: item.count,
        slot: item.slot
      }));

      if (items.length === 0) {
        return factory.createResponse("Inventory is empty");
      }

      let inventoryText = `Found ${items.length} items in inventory:\n\n`;
      itemList.forEach(item => {
        inventoryText += `- ${item.name} (x${item.count}) in slot ${item.slot}\n`;
      });

      return factory.createResponse(inventoryText);
    }
  );

  factory.registerTool(
    "find-item",
    "Find a specific item in the bot's inventory",
    {
      nameOrType: z.string().trim().min(1).describe("Name or type of item to find")
    },
    async ({ nameOrType }) => {
      const bot = getBot();
      const items = getInventoryAuthority(bot).items();
      const item = chooseExactItem(items, nameOrType);

      if (item) {
        return factory.createResponse(`Found ${item.count} ${item.name} in inventory (slot ${item.slot})`);
      } else {
        return factory.createResponse(`Couldn't find any item matching '${nameOrType}' in inventory`);
      }
    }
  );

  factory.registerTool(
    "equip-item",
    "Equip a specific item",
    {
      itemName: z.string().trim().min(1).describe("Name of the item to equip"),
      destination: z.enum(['hand', 'head', 'torso', 'legs', 'feet', 'off-hand']).optional().describe("Where to equip the item (default: 'hand')")
    },
    async ({ itemName, destination = 'hand' }) => {
      const bot = getBot();
      const items = getInventoryAuthority(bot).items();
      const item = chooseExactItem(items, itemName);

      if (!item) {
        return factory.createErrorResponse(`Couldn't find any item matching '${itemName}' in authoritative inventory`);
      }

      await equipVerified(bot, item.slot, destination as mineflayer.EquipmentDestination);
      return factory.createResponse(destination === 'hand' ? `Selected ${item.name} in hand; inventory slot server-confirmed, hotbar selection sent` : `Server-confirmed ${item.name} equipped to ${destination}`);
    }
  );
}
