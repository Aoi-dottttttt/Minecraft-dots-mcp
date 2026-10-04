/** Enchanting table + anvil tools. */

import { z } from "zod";
import { Vec3 } from "vec3";
import type { Item } from "prismarine-item";
import type { Registrar } from "./registry.js";
import { coordsShape, itemRef } from "../schemas/common.js";
import { ToolError } from "../util/errors.js";
import { resolveItem } from "../util/resolve.js";
import { serializeItem } from "../util/serialize.js";
import { DEFAULT_ACTION_TIMEOUT_MS } from "../config.js";

const READY_TIMEOUT_MS = 10_000;

/** Find a matching Item instance in the bot's inventory by resolved name. */
function findInventoryItem(bot: any, ref: string | number): Item {
  const resolved = resolveItem(bot.registry as any, ref);
  const item = bot.inventory.items().find((i: Item) => i.name === resolved.name);
  if (!item) {
    throw new ToolError(
      "MISSING_ITEM",
      `No "${resolved.name}" found in inventory.`,
      [`Carry at least one ${resolved.name} before calling this tool.`],
    );
  }
  return item;
}

/** Wait for the enchantment table's offers to populate (the 'ready' event), or time out. */
function waitForEnchantReady(table: any, timeoutMs: number): Promise<void> {
  const offers = table.enchantments as Array<{ level: number }> | undefined;
  const populated = Array.isArray(offers) && offers.some((o) => o && o.level > 0);
  if (populated) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      try {
        table.removeListener?.("ready", finish);
      } catch {
        /* ignore */
      }
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      table.once?.("ready", finish);
    } catch {
      finish();
    }
  });
}

export function registerEnchantAnvil(reg: Registrar): void {
  reg({
    name: "enchant_item",
    group: "enchanting",
    description:
      "Open the enchantment table at (x,y,z), insert an item (and lapis lazuli if available), and read or apply an enchantment offer. " +
      "Omit `choice` to just return the three offers (top/middle/bottom slots 0/1/2). Provide `choice` (0-2) to apply that offer and take the enchanted item back. " +
      "Requires line of sight / reach to the table and lapis lazuli in inventory to actually enchant.",
    inputSchema: {
      ...coordsShape,
      item: itemRef.describe("Item to enchant (name or id); must be in inventory"),
      choice: z
        .number()
        .int()
        .min(0)
        .max(2)
        .optional()
        .describe("Offer slot to apply (0=top,1=middle,2=bottom). Omit to only read offers."),
    },
    annotations: { title: "Enchant item", destructiveHint: true },
    timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const block = bot.blockAt(new Vec3(args.x, args.y, args.z));
      if (!block) {
        throw new ToolError("NOT_FOUND", `No block at (${args.x}, ${args.y}, ${args.z}).`);
      }
      const target = findInventoryItem(bot, args.item);

      const table = (await bot.openEnchantmentTable(block)) as any;
      ctx.windows.set("enchant", table);

      try {
        // Insert the target item.
        if (typeof table.putTargetItem === "function") {
          await table.putTargetItem(target);
        } else {
          throw new ToolError("UNSUPPORTED", "This enchantment table wrapper does not support putTargetItem.");
        }

        // Insert lapis lazuli if we have any (needed to compute / apply offers).
        try {
          const lapis = bot.inventory.items().find((i: Item) => i.name === "lapis_lazuli");
          if (lapis && typeof table.putLapis === "function") {
            await table.putLapis(lapis);
          }
        } catch {
          /* lapis insertion is best-effort */
        }

        // Wait for offers to be computed by the server.
        await waitForEnchantReady(table, READY_TIMEOUT_MS);

        const offers = (table.enchantments ?? []) as Array<{ level: number; expected?: unknown }>;

        if (args.choice == null) {
          return { ok: true, offers };
        }

        const offer = offers[args.choice];
        if (!offer || offer.level <= 0) {
          throw new ToolError(
            "INVALID_ARGS",
            `Offer slot ${args.choice} is not available (no valid enchantment, or insufficient levels/lapis).`,
            ["Read offers first by omitting `choice`, then pick an affordable slot."],
          );
        }

        await table.enchant(args.choice);
        let out: Item | null = null;
        try {
          out = await table.takeTargetItem();
        } catch {
          /* item may already have been returned to inventory */
        }
        return { ok: true, choice: args.choice, enchanted: serializeItem(out, true) };
      } catch (e) {
        throw e instanceof ToolError ? e : new ToolError("INTERNAL", String((e as Error)?.message ?? e));
      } finally {
        try {
          table.close?.();
        } catch {
          /* ignore */
        }
        ctx.windows.clear();
      }
    },
  });

  reg({
    name: "anvil_combine",
    group: "enchanting",
    description:
      "Open the anvil at (x,y,z) and combine/repair two items (or rename a single item). " +
      "Identify each input either by inventory slot number (itemOneSlot/itemTwoSlot) or by item name/id (itemOne/itemTwo); slot wins if both are given. " +
      "Provide only the first item plus `name` to rename. Costs experience levels; result is taken back into inventory.",
    inputSchema: {
      ...coordsShape,
      itemOneSlot: z.number().int().optional().describe("Inventory slot of the first (base) item"),
      itemOne: itemRef.optional().describe("First (base) item by name/id (if itemOneSlot not given)"),
      itemTwoSlot: z.number().int().optional().describe("Inventory slot of the second (sacrifice/material) item"),
      itemTwo: itemRef.optional().describe("Second item by name/id; omit for a rename-only operation"),
      name: z.string().optional().describe("New name to apply to the result (optional)"),
    },
    annotations: { title: "Anvil combine/rename", destructiveHint: true },
    timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const block = bot.blockAt(new Vec3(args.x, args.y, args.z));
      if (!block) {
        throw new ToolError("NOT_FOUND", `No block at (${args.x}, ${args.y}, ${args.z}).`);
      }

      const items = bot.inventory.items() as Item[];
      const bySlot = (slot: number): Item => {
        const it = items.find((i) => i.slot === slot);
        if (!it) throw new ToolError("MISSING_ITEM", `No item in inventory slot ${slot}.`);
        return it;
      };

      // Resolve item one (required).
      let itemOne: Item;
      if (typeof args.itemOneSlot === "number") {
        itemOne = bySlot(args.itemOneSlot);
      } else if (args.itemOne != null) {
        itemOne = findInventoryItem(bot, args.itemOne);
      } else {
        throw new ToolError("INVALID_ARGS", "Provide itemOneSlot or itemOne (the base item).");
      }

      // Resolve item two (optional — omit for rename).
      let itemTwo: Item | undefined;
      if (typeof args.itemTwoSlot === "number") {
        itemTwo = bySlot(args.itemTwoSlot);
      } else if (args.itemTwo != null) {
        itemTwo = findInventoryItem(bot, args.itemTwo);
      }

      const anvil = (await bot.openAnvil(block)) as any;
      ctx.windows.set("anvil", anvil);

      try {
        // mineflayer's anvil always provides BOTH combine and rename, so the
        // rename-only path (no second item) must be checked FIRST.
        if (itemTwo == null && typeof anvil.rename === "function") {
          await anvil.rename(itemOne, args.name);
        } else if (typeof anvil.combine === "function") {
          await anvil.combine(itemOne, itemTwo ?? undefined, args.name);
        } else {
          throw new ToolError("UNSUPPORTED", "This anvil wrapper supports neither combine nor rename.");
        }
        return {
          ok: true,
          renamedTo: args.name ?? null,
          combined: itemTwo != null,
        };
      } catch (e) {
        throw e instanceof ToolError ? e : new ToolError("INTERNAL", String((e as Error)?.message ?? e));
      } finally {
        try {
          (anvil as { close?: () => void }).close?.();
        } catch {
          /* ignore */
        }
        ctx.windows.clear();
      }
    },
  });
}
