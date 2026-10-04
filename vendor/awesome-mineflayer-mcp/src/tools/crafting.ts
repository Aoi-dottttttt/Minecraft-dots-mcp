/** Crafting tools: inspect recipes and craft items. */

import { z } from "zod";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import type { Recipe, RecipeItem } from "prismarine-recipe";
import type { Registrar } from "./registry.js";
import { itemRef } from "../schemas/common.js";
import { ToolError } from "../util/errors.js";
import { resolveItem, resolveBlock } from "../util/resolve.js";
import { withTimeout } from "../util/async.js";
import { DEFAULT_ACTION_TIMEOUT_MS } from "../config.js";

/** Resolve a numeric item id to its registry name (or a fallback string). */
function itemName(bot: Bot, id: number | null | undefined): string {
  if (id == null || id < 0) return "air";
  const entry = (bot.registry as any).items?.[id];
  return entry?.name ?? `item_${id}`;
}

/** Collapse a list of RecipeItem-like entries into [{name,count}] merged by name. */
function tallyIngredients(bot: Bot, items: Array<RecipeItem | null | undefined>): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const it of items) {
    if (!it || it.id == null || it.id < 0) continue;
    const name = itemName(bot, it.id);
    counts.set(name, (counts.get(name) ?? 0) + Math.abs(it.count ?? 1));
  }
  return Array.from(counts, ([name, count]) => ({ name, count }));
}

/** Compact, name-resolved view of a single recipe. */
function serializeRecipeCompact(bot: Bot, r: Recipe): Record<string, unknown> {
  // Prefer the flat ingredient list; fall back to the shaped grid for shaped recipes.
  let raw: Array<RecipeItem | null | undefined> = Array.isArray(r.ingredients) ? r.ingredients : [];
  if (raw.length === 0 && Array.isArray(r.inShape)) {
    raw = r.inShape.flat();
  }
  if (raw.length === 0 && Array.isArray(r.delta)) {
    // delta carries negative counts for consumed items.
    raw = r.delta.filter((d) => d && (d.count ?? 0) < 0);
  }
  return {
    result: { name: itemName(bot, r.result?.id), count: r.result?.count ?? 1 },
    ingredients: tallyIngredients(bot, raw),
    requiresTable: r.requiresTable ?? null,
  };
}

export function registerCrafting(reg: Registrar): void {
  reg({
    name: "list_recipes",
    group: "crafting",
    description:
      "List crafting recipes for an item. By default returns only recipes craftable with the bot's current inventory (recipesFor); set includeUnavailable to list every known recipe (recipesAll). Set useCraftingTable to consider table-only recipes using a crafting table within 4 blocks.",
    inputSchema: {
      item: itemRef,
      includeUnavailable: z.boolean().optional().describe("List all known recipes, not just currently craftable ones (default false)"),
      useCraftingTable: z.boolean().optional().describe("Allow recipes that need a crafting table, using one within 4 blocks (default false)"),
      minResultCount: z.number().int().optional().describe("Minimum result count to require (recipesFor only; default 1)"),
    },
    annotations: { readOnlyHint: true, title: "List recipes" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const id = resolveItem(bot.registry as any, args.item).id;
      let tableBlock: unknown = null;
      if (args.useCraftingTable) {
        tableBlock = bot.findBlock({
          matching: resolveBlock(bot.registry as any, "crafting_table").id,
          maxDistance: 4,
        });
      }
      const recipes = args.includeUnavailable
        ? bot.recipesAll(id, null, args.useCraftingTable ? (tableBlock as any) : null)
        : bot.recipesFor(id, null, args.minResultCount ?? 1, args.useCraftingTable ? (tableBlock as any) : null);
      return {
        count: recipes.length,
        recipes: recipes.map((r) => serializeRecipeCompact(bot, r)),
      };
    },
  });

  reg({
    name: "craft_item",
    group: "crafting",
    description:
      "Craft an item using the bot's inventory. Uses a crafting table within 4 blocks (or at craftingTablePos) when the recipe requires one. Crafts `count` times (default 1). Cancellable.",
    inputSchema: {
      item: itemRef,
      count: z.number().int().min(1).optional().describe("How many times to craft (default 1)"),
      craftingTablePos: z
        .object({ x: z.number().int(), y: z.number().int(), z: z.number().int() })
        .optional()
        .describe("Position of a crafting table to use; defaults to one within 4 blocks"),
    },
    annotations: { title: "Craft item" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const resolved = resolveItem(bot.registry as any, args.item);
      const id = resolved.id;
      const table = args.craftingTablePos
        ? bot.blockAt(new Vec3(args.craftingTablePos.x, args.craftingTablePos.y, args.craftingTablePos.z))
        : bot.findBlock({ matching: resolveBlock(bot.registry as any, "crafting_table").id, maxDistance: 4 });
      const recipes = bot.recipesFor(id, null, 1, table as any);
      if (!recipes.length) {
        throw new ToolError(
          "MISSING_MATERIALS",
          `No craftable recipe for ${resolved.name} with current items${table ? "" : " / no crafting table nearby"}`,
        );
      }
      const count = args.count ?? 1;
      const h = ctx.locks.begin("craft_item");
      try {
        // Bound the craft so a stalled server round-trip can't wedge the action
        // lock forever — the timeout throws, so the finally below releases it.
        await withTimeout(
          bot.craft(recipes[0]!, count, (table ?? undefined) as any),
          DEFAULT_ACTION_TIMEOUT_MS,
          "craft_item",
        );
        return { ok: true, crafted: resolved.name, count };
      } catch (e) {
        if (h.signal.aborted) throw new ToolError("CANCELLED", "craft_item was cancelled");
        throw e instanceof ToolError ? e : new ToolError("INTERNAL", String((e as Error)?.message ?? e));
      } finally {
        h.release();
      }
    },
  });
}
