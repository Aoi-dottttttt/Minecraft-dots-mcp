/** Block / item gathering tools (mineflayer-collectblock). */

import { z } from "zod";
import { Vec3 } from "vec3";
import type { Registrar } from "./registry.js";
import { ToolError } from "../util/errors.js";
import { resolveBlock } from "../util/resolve.js";

const coordObj = z.object({ x: z.number(), y: z.number(), z: z.number() });

/** Build the collectblock itemFilter from deposit/keep lists. */
function makeItemFilter(
  depositItems?: string[],
  keepItems?: string[],
): ((item: { name: string }) => boolean) | undefined {
  if (depositItems) return (item) => depositItems.includes(item.name);
  if (keepItems) return (item) => !keepItems.includes(item.name);
  return undefined;
}

export function registerGathering(reg: Registrar): void {
  reg({
    name: "collect_block",
    group: "gathering",
    description:
      "Break and collect block(s) (or pick up an item-drop entity) using the collectblock plugin. " +
      "`target` is a block name (collects the N nearest, see `count`), a {x,y,z} block position, or a numeric entity id (item drop). " +
      "When the inventory fills, items are deposited into `chestLocations`; use `depositItems`/`keepItems` to control what gets stored. Long-running and cancellable.",
    inputSchema: {
      target: z
        .union([z.string(), coordObj, z.number().int()])
        .describe('Block name (e.g. "oak_log"), a {x,y,z} block position, or a numeric item-drop entity id'),
      count: z.number().int().min(1).max(256).optional().describe("When target is a block name, how many nearest blocks to collect (default 1)"),
      append: z.boolean().optional().describe("Append to the existing collection task instead of starting fresh"),
      ignoreNoPath: z.boolean().optional().describe("Do not error if no path to a target can be found; pick the best reachable spot"),
      chestLocations: z.array(coordObj).optional().describe("Chest positions to deposit into when the inventory fills"),
      depositItems: z.array(z.string()).optional().describe("Only these item names are moved to a chest (mutually exclusive with keepItems)"),
      keepItems: z.array(z.string()).optional().describe("Keep these item names; everything else may be deposited"),
    },
    annotations: { title: "Collect block" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const collectBlock = (bot as any).collectBlock;
      if (!collectBlock) throw new ToolError("PLUGIN_MISSING", "The collectblock plugin is not loaded.");

      let targets: unknown[];
      if (typeof args.target === "string") {
        const id = resolveBlock(bot.registry as any, args.target).id;
        const positions = bot.findBlocks({ matching: [id], maxDistance: 64, count: args.count ?? 1 } as any);
        const blocks = positions.map((p) => bot.blockAt(p)).filter((b): b is NonNullable<typeof b> => Boolean(b));
        if (blocks.length === 0) {
          throw new ToolError("NOT_FOUND", `No "${args.target}" block found within 64 blocks.`, [
            "Move closer or use find_blocks to locate the resource first.",
          ]);
        }
        targets = blocks;
      } else if (typeof args.target === "number") {
        const e = bot.entities[args.target];
        if (!e) throw new ToolError("NOT_FOUND", `No entity with id ${args.target} is currently tracked.`);
        targets = [e];
      } else {
        const block = bot.blockAt(new Vec3(args.target.x, args.target.y, args.target.z));
        if (!block) {
          throw new ToolError("NOT_FOUND", `No block at (${args.target.x}, ${args.target.y}, ${args.target.z}). The chunk may be unloaded.`);
        }
        targets = [block];
      }

      const options: Record<string, unknown> = {
        append: args.append,
        ignoreNoPath: args.ignoreNoPath,
      };
      if (args.chestLocations) {
        options.chestLocations = args.chestLocations.map((c) => new Vec3(c.x, c.y, c.z));
      }
      const itemFilter = makeItemFilter(args.depositItems, args.keepItems);
      if (itemFilter) options.itemFilter = itemFilter;

      const h = ctx.locks.begin("collect_block", () => {
        try {
          collectBlock.cancelTask?.();
        } catch {
          /* best-effort */
        }
      });
      try {
        await collectBlock.collect(targets.length === 1 ? targets[0] : targets, options as any);
        return { ok: true, collected: targets.length };
      } catch (e) {
        if (h.signal.aborted) throw new ToolError("CANCELLED", "collect_block was cancelled");
        if (e instanceof ToolError) throw e;
        const msg = String((e as Error)?.message ?? e);
        if (/no path|cannot reach|unable to reach/i.test(msg)) {
          throw new ToolError("NO_PATH", `Could not reach the target block: ${msg}`, [
            "Try ignoreNoPath:true, or clear obstacles / move closer.",
          ]);
        }
        if (/inventory.*full|no.*chest/i.test(msg)) {
          throw new ToolError("INVENTORY_FULL_NO_CHEST", `Inventory is full with nowhere to deposit: ${msg}`, [
            "Provide chestLocations (or call set_collect_config) so the bot can deposit items.",
          ]);
        }
        throw new ToolError("INTERNAL", msg);
      } finally {
        h.release();
      }
    },
  });

  reg({
    name: "cancel_collect",
    group: "gathering",
    description: "Cancel the active collect_block task and abort any in-progress gathering action.",
    inputSchema: {},
    annotations: { title: "Cancel collect" },
    handler: async (_args, ctx) => {
      const bot = ctx.manager.requireBot();
      const collectBlock = (bot as any).collectBlock;
      try {
        await collectBlock?.cancelTask?.();
      } catch {
        /* best-effort */
      }
      ctx.locks.cancelAll("manual");
      return { ok: true };
    },
  });

  reg({
    name: "set_collect_config",
    group: "gathering",
    description:
      "Set persistent collectblock defaults: the chest locations to deposit into when full, and the item filter (depositItems or keepItems) used for those deposits.",
    inputSchema: {
      chestLocations: z.array(coordObj).optional().describe("Chest positions to deposit into when the inventory fills"),
      depositItems: z.array(z.string()).optional().describe("Only these item names are moved to a chest (mutually exclusive with keepItems)"),
      keepItems: z.array(z.string()).optional().describe("Keep these item names; everything else may be deposited"),
    },
    annotations: { title: "Set collect config" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const collectBlock = (bot as any).collectBlock;
      if (!collectBlock) throw new ToolError("PLUGIN_MISSING", "The collectblock plugin is not loaded.");
      if (args.chestLocations) {
        collectBlock.chestLocations = args.chestLocations.map((c) => new Vec3(c.x, c.y, c.z));
      }
      const itemFilter = makeItemFilter(args.depositItems, args.keepItems);
      if (itemFilter) collectBlock.itemFilter = itemFilter;
      return { ok: true, chestLocations: (collectBlock.chestLocations as unknown[] | undefined)?.length ?? 0 };
    },
  });
}
