/** Creative-mode tools: inventory editing and creative flight. */

import { z } from "zod";
import { Vec3 } from "vec3";
import mcItemLoader from "prismarine-item";
import type { Registrar } from "./registry.js";
import { coordsShape, itemRef } from "../schemas/common.js";
import { ToolError } from "../util/errors.js";
import { resolveItem } from "../util/resolve.js";

export function registerCreative(reg: Registrar): void {
  reg({
    name: "creative_set_inventory_slot",
    group: "creative",
    description:
      "Set the contents of an inventory slot in creative mode. Pass `item` (name or id) with optional `count`/`nbt` to place a stack, or omit `item` (or set it null) to empty the slot. Requires the bot to be in creative gamemode.",
    inputSchema: {
      slot: z.number().int().describe("Inventory slot index to overwrite"),
      item: itemRef.nullable().optional().describe("Item name/id to place; null or omitted clears the slot"),
      count: z.number().int().min(1).optional().describe("Stack size (default 1)"),
      nbt: z.any().optional().describe("Raw prismarine-nbt tag to attach to the item"),
    },
    annotations: { title: "Creative set slot" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      if (args.item === null || args.item === undefined) {
        await bot.creative.setInventorySlot(args.slot, null);
        return { ok: true, slot: args.slot, item: null };
      }
      const resolved = resolveItem(bot.registry as any, args.item);
      const Item = (mcItemLoader as any)(bot.registry as any);
      const it = new Item(resolved.id, args.count ?? 1);
      if (args.nbt) (it as any).nbt = args.nbt;
      try {
        await bot.creative.setInventorySlot(args.slot, it);
      } catch (e) {
        throw e instanceof ToolError ? e : new ToolError("INTERNAL", String((e as Error)?.message ?? e));
      }
      return { ok: true, slot: args.slot, item: { name: resolved.name, count: args.count ?? 1 } };
    },
  });

  reg({
    name: "creative_clear_inventory",
    group: "creative",
    description: "Empty the bot's entire inventory in creative mode. Requires creative gamemode.",
    inputSchema: {},
    annotations: { title: "Creative clear inventory" },
    handler: async (_args, ctx) => {
      const bot = ctx.manager.requireBot();
      await bot.creative.clearInventory();
      return { ok: true };
    },
  });

  reg({
    name: "creative_fly",
    group: "creative",
    description:
      "Toggle creative-mode flight. `enabled: true` starts flying (lifts the bot off the ground); `false` stops flying and lets it fall.",
    inputSchema: {
      enabled: z.boolean().describe("Start (true) or stop (false) flying"),
    },
    annotations: { title: "Creative fly toggle" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      if (args.enabled) bot.creative.startFlying();
      else bot.creative.stopFlying();
      return { ok: true, flying: args.enabled };
    },
  });

  reg({
    name: "creative_fly_to",
    group: "creative",
    description:
      "Fly straight to a world coordinate in creative mode. Resolves once the bot reaches the destination. Best for short, obstacle-free hops; use pathfinding (`goto`) for navigation around terrain.",
    inputSchema: {
      ...coordsShape,
    },
    annotations: { openWorldHint: true, title: "Creative fly to" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const dest = new Vec3(args.x, args.y, args.z);
      try {
        await bot.creative.flyTo(dest);
      } catch (e) {
        throw e instanceof ToolError ? e : new ToolError("INTERNAL", String((e as Error)?.message ?? e));
      }
      return { ok: true, destination: { x: args.x, y: args.y, z: args.z } };
    },
  });
}
