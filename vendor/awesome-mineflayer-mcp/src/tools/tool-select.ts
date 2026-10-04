/** Tool selection helpers (mineflayer-tool): pick the best tool for a block. */

import { z } from "zod";
import { Vec3 } from "vec3";
import type { Block } from "prismarine-block";
import type { Registrar } from "./registry.js";
import { coordsShape, blockRef } from "../schemas/common.js";
import { ToolError } from "../util/errors.js";
import { resolveBlock } from "../util/resolve.js";

export function registerToolSelect(reg: Registrar): void {
  reg({
    name: "equip_tool_for_block",
    group: "tool",
    description:
      "Equip the best tool in inventory for breaking a target block. Specify the block by coordinates (x,y,z) or by blockId (nearest matching block within 64 is used). With getFromChest, retrieves a suitable tool from a configured tool chest if none is held.",
    inputSchema: {
      x: z.number().optional().describe("X coordinate of the target block"),
      y: z.number().optional().describe("Y coordinate of the target block"),
      z: z.number().optional().describe("Z coordinate of the target block"),
      blockId: blockRef.optional().describe("Block name/id to find the nearest of (when no coords given)"),
      requireHarvest: z.boolean().optional().describe("Only use tools that can actually harvest the block (default false)"),
      getFromChest: z.boolean().optional().describe("Retrieve a tool from a configured chest if none held (default false)"),
      maxTools: z.number().int().min(1).optional().describe("Max tools to pull from chest at once (default 1)"),
    },
    annotations: { title: "Equip tool for block" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      let block: Block | null = null;
      if (args.x !== undefined && args.y !== undefined && args.z !== undefined) {
        block = bot.blockAt(new Vec3(args.x, args.y, args.z));
        if (!block) throw new ToolError("NOT_FOUND", `No block at (${args.x}, ${args.y}, ${args.z}) (chunk may be unloaded).`);
      } else if (args.blockId !== undefined) {
        const resolved = resolveBlock(bot.registry as any, args.blockId);
        block = bot.findBlock({ matching: resolved.id, maxDistance: 64 });
        if (!block) throw new ToolError("NOT_FOUND", `No ${resolved.name} found within 64 blocks.`);
      } else {
        throw new ToolError("INVALID_ARGS", "Provide either x/y/z coordinates or a blockId.");
      }
      await (bot as any).tool.equipForBlock(block, {
        requireHarvest: args.requireHarvest,
        getFromChest: args.getFromChest,
        maxTools: args.maxTools,
      });
      return { ok: true, block: block.name, equipped: bot.heldItem?.name ?? null };
    },
  });

  reg({
    name: "set_tool_chest_locations",
    group: "tool",
    description:
      "Configure the chest locations the tool plugin may pull tools from when equip_tool_for_block uses getFromChest. Modes: 'set' (replace, default), 'add' (append), 'clear' (remove all).",
    inputSchema: {
      locations: z
        .array(z.object({ x: z.number(), y: z.number(), z: z.number() }))
        .describe("Chest coordinates"),
      mode: z.enum(["set", "add", "clear"]).optional().describe("How to apply locations (default 'set')"),
    },
    annotations: { title: "Set tool chest locations" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const arr = (bot as any).tool.chestLocations as Vec3[];
      const vecs = args.locations.map((l) => new Vec3(l.x, l.y, l.z));
      if (args.mode === "clear") {
        arr.length = 0;
      } else if (args.mode === "add") {
        arr.push(...vecs);
      } else {
        arr.length = 0;
        arr.push(...vecs);
      }
      return { ok: true, count: arr.length };
    },
  });

  reg({
    name: "get_best_tool",
    group: "tool",
    description:
      "Determine the best harvest tool currently in inventory for the block at the given coordinates, without equipping it. Returns null if no tool is better than hand.",
    inputSchema: { ...coordsShape },
    annotations: { readOnlyHint: true, title: "Get best tool" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const block = bot.blockAt(new Vec3(args.x, args.y, args.z));
      if (!block) throw new ToolError("NOT_FOUND", `No block at (${args.x}, ${args.y}, ${args.z}) (chunk may be unloaded).`);
      const item = bot.pathfinder.bestHarvestTool(block);
      return { block: block.name, bestTool: item ? item.name : null };
    },
  });
}
