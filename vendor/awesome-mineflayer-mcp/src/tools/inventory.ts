/** Inventory & item manipulation tools. */

import { z } from "zod";
import type { Registrar } from "./registry.js";
import { itemRef, equipDestination } from "../schemas/common.js";
import { ToolError } from "../util/errors.js";
import { resolveItem } from "../util/resolve.js";

export function registerInventory(reg: Registrar): void {
  reg({
    name: "equip_item",
    group: "inventory",
    description:
      "Equip an item from inventory to a destination slot. `hand`/`off-hand` hold it; `head`/`torso`/`legs`/`feet` wear armor.",
    inputSchema: {
      item: itemRef,
      destination: equipDestination,
    },
    annotations: { title: "Equip item" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const id = resolveItem(bot.registry as any, args.item).id;
      await bot.equip(id, args.destination);
      return { ok: true, item: args.item, destination: args.destination };
    },
  });

  reg({
    name: "unequip_item",
    group: "inventory",
    description: "Remove whatever is equipped at a destination slot (e.g. take off a helmet, empty the off-hand).",
    inputSchema: {
      destination: equipDestination,
    },
    annotations: { title: "Unequip item" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      await bot.unequip(args.destination);
      return { ok: true, destination: args.destination };
    },
  });

  reg({
    name: "toss_item",
    group: "inventory",
    description:
      "Drop items on the ground. Provide `slot` to toss that exact inventory slot's whole stack, or `item` (+ optional `count`) to toss by item type (omitting count tosses the whole stack).",
    inputSchema: {
      item: itemRef.optional().describe("Item name/id to toss (ignored if `slot` is given)"),
      count: z.number().int().min(1).optional().describe("How many to toss; omit to toss the whole stack"),
      slot: z.number().int().optional().describe("Inventory slot index to toss its whole stack from"),
    },
    annotations: { title: "Toss item" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      if (args.slot != null) {
        const it = bot.inventory.slots[args.slot];
        if (!it) throw new ToolError("NOT_FOUND", `No item in inventory slot ${args.slot}.`);
        await bot.tossStack(it);
        return { ok: true, slot: args.slot };
      }
      if (args.item == null) {
        throw new ToolError("INVALID_ARGS", "Provide either `slot` or `item` to toss.");
      }
      const r = resolveItem(bot.registry as any, args.item);
      await bot.toss(r.id, null, args.count ?? null);
      return { ok: true, item: r.name, count: args.count ?? null };
    },
  });

  reg({
    name: "set_quickbar_slot",
    group: "inventory",
    description: "Select the active hotbar slot (0-8), like scrolling the mouse wheel to a hotbar position.",
    inputSchema: {
      slot: z.number().int().min(0).max(8).describe("Hotbar slot index 0-8"),
    },
    annotations: { title: "Set hotbar slot" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      bot.setQuickBarSlot(args.slot);
      return { ok: true, slot: args.slot };
    },
  });

  reg({
    name: "consume",
    group: "inventory",
    description: "Eat or drink the currently held item (food/potion). Hold the consumable in the main hand first.",
    inputSchema: {},
    annotations: { title: "Consume held item" },
    handler: async (_args, ctx) => {
      const bot = ctx.manager.requireBot();
      // Detect the true missing-item case explicitly; let other failures
      // (interrupted use, disconnect, …) surface as their real INTERNAL error.
      if (!bot.heldItem) {
        throw new ToolError("MISSING_ITEM", "Nothing is held in the main hand to consume.", [
          "Equip an edible/drinkable item to the hand first.",
        ]);
      }
      await bot.consume();
      return { ok: true };
    },
  });

  reg({
    name: "activate_item",
    group: "inventory",
    description:
      "Start or stop using the held item (right-click hold). Use action `start` to begin (e.g. draw a bow, raise a shield, eat) and `stop` to release.",
    inputSchema: {
      offHand: z.boolean().optional().describe("Activate the off-hand item instead of the main hand (default false)"),
      action: z.enum(["start", "stop"]).optional().describe('"start" (default) to activate, "stop" to deactivate'),
    },
    annotations: { title: "Activate/deactivate item" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      if (args.action === "stop") {
        bot.deactivateItem();
        return { ok: true, action: "stop" };
      }
      bot.activateItem(args.offHand ?? false);
      return { ok: true, action: "start", offHand: args.offHand ?? false };
    },
  });

  reg({
    name: "click_window",
    group: "inventory",
    description:
      "Low-level window click. `slot` is the window slot index, `mouseButton` 0=left/1=right, `mode` 0-6 (0 normal, 1 shift, 2 number-key, 4 drop, etc). Prefer higher-level tools when possible.",
    inputSchema: {
      slot: z.number().int().describe("Window slot index"),
      mouseButton: z.number().int().min(0).max(1).describe("0 = left, 1 = right"),
      mode: z.number().int().min(0).max(6).describe("Click mode 0-6 (see Minecraft window protocol)"),
    },
    annotations: { title: "Click window slot" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      await bot.clickWindow(args.slot, args.mouseButton, args.mode);
      return { ok: true, slot: args.slot, mouseButton: args.mouseButton, mode: args.mode };
    },
  });

  reg({
    name: "move_slot_item",
    group: "inventory",
    description:
      "Move the stack in `sourceSlot` to `destSlot` within the open window/inventory. If `destSlot` is omitted, put the item away into the main inventory (out of the hotbar/crafting/armor area).",
    inputSchema: {
      sourceSlot: z.number().int().describe("Source slot index"),
      destSlot: z.number().int().optional().describe("Destination slot index; omit to put the item away"),
    },
    annotations: { title: "Move slot item" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      if (args.destSlot == null) {
        await bot.putAway(args.sourceSlot);
        return { ok: true, sourceSlot: args.sourceSlot, putAway: true };
      }
      await bot.moveSlotItem(args.sourceSlot, args.destSlot);
      return { ok: true, sourceSlot: args.sourceSlot, destSlot: args.destSlot };
    },
  });

  reg({
    name: "transfer_items",
    group: "inventory",
    description:
      "Bulk-transfer a quantity of an item between slot ranges of a window. Defaults move within the player inventory (slots 9-45). Set `window` true to operate on the currently open container window instead.",
    inputSchema: {
      item: itemRef,
      count: z.number().int().min(1).optional().describe("How many to move; omit to move all available"),
      sourceStart: z.number().int().optional().describe("Source range start slot (default 9)"),
      sourceEnd: z.number().int().optional().describe("Source range end slot, exclusive (default 45)"),
      destStart: z.number().int().optional().describe("Destination range start slot (default 9)"),
      destEnd: z.number().int().optional().describe("Destination range end slot, exclusive (default 45)"),
      window: z.boolean().optional().describe("Operate on the open container window instead of the player inventory"),
    },
    annotations: { title: "Transfer items" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const itemType = resolveItem(bot.registry as any, args.item).id;
      const win = args.window ? (bot.currentWindow ?? bot.inventory) : bot.inventory;
      const options: any = {
        window: win,
        itemType,
        metadata: null,
        sourceStart: args.sourceStart ?? 9,
        sourceEnd: args.sourceEnd ?? 45,
        destStart: args.destStart ?? 9,
        destEnd: args.destEnd ?? 45,
      };
      if (args.count != null) options.count = args.count;
      await bot.transfer(options);
      return { ok: true, item: args.item, count: args.count ?? null };
    },
  });
}
