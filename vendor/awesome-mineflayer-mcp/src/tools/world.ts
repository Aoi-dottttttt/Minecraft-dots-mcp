/** Read-only world inspection tools. */

import { z } from "zod";
import { Vec3 } from "vec3";
import type { Block } from "prismarine-block";
import type { Registrar } from "./registry.js";
import { coordsShape, formatShape, blockRef } from "../schemas/common.js";
import { ToolError } from "../util/errors.js";
import { resolveBlock } from "../util/resolve.js";
import { serializeBlock, serializeEntity } from "../util/serialize.js";

const MAX_REGION_VOLUME = 32_768; // 32^3 — guard against runaway scans

export function registerWorld(reg: Registrar): void {
  reg({
    name: "get_block_at",
    group: "world",
    description:
      "Inspect the block at a world coordinate. Returns name/position and (detailed) hardness, diggability, line-of-sight, estimated dig time and sign text. Returns name 'air'/null-ish if the chunk is unloaded.",
    inputSchema: {
      ...coordsShape,
      extraInfos: z.boolean().optional().describe("Include sign/painting/block-entity data (slower). Default true."),
      ...formatShape,
    },
    annotations: { readOnlyHint: true, title: "Get block" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const detailed = args.format === "detailed";
      const block = bot.blockAt(new Vec3(args.x, args.y, args.z), args.extraInfos ?? true);
      if (!block) return { position: { x: args.x, y: args.y, z: args.z }, loaded: false, block: null };
      const out = serializeBlock(block, detailed) as unknown as Record<string, unknown>;
      const b = bot as any;
      try {
        out.canSee = b.canSeeBlock?.(block) ?? null;
      } catch {
        out.canSee = null;
      }
      try {
        out.canDig = b.canDigBlock?.(block) ?? null;
      } catch {
        out.canDig = null;
      }
      try {
        out.digTimeMs = typeof b.digTime === "function" ? b.digTime(block.type) : null;
      } catch {
        out.digTimeMs = null;
      }
      return { loaded: true, ...out };
    },
  });

  reg({
    name: "find_blocks",
    group: "world",
    description:
      "Search for nearby blocks matching a block name (or list of names), nearest-first. Returns positions; set returnClosestBlock to also get the full closest block.",
    inputSchema: {
      matching: z
        .union([blockRef, z.array(blockRef)])
        .describe('Block name(s)/id(s) to match, e.g. "iron_ore" or ["coal_ore","copper_ore"]'),
      maxDistance: z.number().int().min(1).max(256).optional().describe("Search radius in blocks (default 32)"),
      count: z.number().int().min(1).max(500).optional().describe("Max number of blocks to find (default 25)"),
      point: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional().describe("Search origin (default bot position)"),
      returnClosestBlock: z.boolean().optional(),
      ...formatShape,
    },
    annotations: { readOnlyHint: true, title: "Find blocks" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const refs = Array.isArray(args.matching) ? args.matching : [args.matching];
      const ids = refs.map((r) => resolveBlock(bot.registry as any, r).id);
      const options = {
        matching: ids,
        maxDistance: args.maxDistance ?? 32,
        count: args.count ?? 25,
        point: args.point ? new Vec3(args.point.x, args.point.y, args.point.z) : bot.entity.position,
      };
      const positions = bot.findBlocks(options as any);
      const result: Record<string, unknown> = {
        matched: refs,
        found: positions.length,
        positions: positions.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      };
      if (args.returnClosestBlock && positions.length > 0) {
        result.closest = serializeBlock(bot.blockAt(positions[0]!), args.format === "detailed");
      }
      return result;
    },
  });

  reg({
    name: "get_cursor_target",
    group: "world",
    description:
      "Raycast from the bot's eyes along its look direction. Returns the first block hit and (if includeEntity) the entity being aimed at.",
    inputSchema: {
      maxDistance: z.number().min(1).max(256).optional().describe("Max block reach for the block raycast (default 256)"),
      includeEntity: z.boolean().optional().describe("Also return the entity at the cursor (default true)"),
      entityMaxDistance: z.number().min(1).max(64).optional().describe("Max reach for entity raycast (default 4)"),
      ...formatShape,
    },
    annotations: { readOnlyHint: true, title: "Get cursor target" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const detailed = args.format === "detailed";
      const block = bot.blockAtCursor(args.maxDistance ?? 256);
      const out: Record<string, unknown> = { block: serializeBlock(block as Block | null, detailed) };
      if (args.includeEntity ?? true) {
        const entity = bot.entityAtCursor(args.entityMaxDistance ?? 4);
        out.entity = entity ? serializeEntity(entity, { detailed, origin: bot.entity.position }) : null;
      }
      return out;
    },
  });

  reg({
    name: "get_blocks_in_region",
    group: "world",
    description:
      "Scan a bounded box [min..max] (inclusive) and return non-air blocks, optionally filtered to specific block names. Volume is capped at 32768 blocks; shrink the box if you hit the cap.",
    inputSchema: {
      min: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
      max: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }),
      matching: z.union([blockRef, z.array(blockRef)]).optional().describe("Restrict to these block name(s)/id(s)"),
      includeAir: z.boolean().optional().describe("Include air blocks (default false)"),
      maxCount: z.number().int().min(1).max(4096).optional().describe("Max blocks to return (default 1024)"),
    },
    annotations: { readOnlyHint: true, title: "Scan region" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const minX = Math.min(args.min.x, args.max.x);
      const minY = Math.min(args.min.y, args.max.y);
      const minZ = Math.min(args.min.z, args.max.z);
      const maxX = Math.max(args.min.x, args.max.x);
      const maxY = Math.max(args.min.y, args.max.y);
      const maxZ = Math.max(args.min.z, args.max.z);
      const volume = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
      if (volume > MAX_REGION_VOLUME) {
        throw new ToolError(
          "INVALID_ARGS",
          `Region volume ${volume} exceeds the ${MAX_REGION_VOLUME}-block cap. Use a smaller box.`,
        );
      }
      let idFilter: Set<number> | null = null;
      if (args.matching) {
        const refs = Array.isArray(args.matching) ? args.matching : [args.matching];
        idFilter = new Set(refs.map((r) => resolveBlock(bot.registry as any, r).id));
      }
      const maxCount = args.maxCount ?? 1024;
      const blocks: Array<Record<string, unknown>> = [];
      let truncated = false;
      const pos = new Vec3(0, 0, 0);
      outer: for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          for (let z = minZ; z <= maxZ; z++) {
            pos.set(x, y, z);
            const block = bot.blockAt(pos);
            if (!block) continue;
            if (!(args.includeAir ?? false) && block.name === "air") continue;
            if (idFilter && !idFilter.has(block.type)) continue;
            blocks.push({ name: block.name, x, y, z });
            if (blocks.length >= maxCount) {
              truncated = true;
              break outer;
            }
          }
        }
      }
      return { scannedVolume: volume, found: blocks.length, truncated, blocks };
    },
  });

  reg({
    name: "wait_for_chunks_to_load",
    group: "world",
    description: "Wait until enough chunks around the bot have loaded. Use after connect/teleport before reading the world.",
    inputSchema: {},
    annotations: { readOnlyHint: true, title: "Wait for chunks" },
    handler: async (_args, ctx) => {
      const bot = ctx.manager.requireBot();
      await bot.waitForChunksToLoad();
      return { ok: true };
    },
  });
}
