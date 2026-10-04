/** Survival tools: auto-eat (mineflayer-auto-eat v5) + armor-manager. */

import { z } from "zod";
import type { Registrar } from "./registry.js";
import { itemRef } from "../schemas/common.js";
import { ToolError } from "../util/errors.js";

const priorityEnum = z.enum([
  "foodPoints",
  "saturation",
  "effectiveQuality",
  "saturationRatio",
]);

export function registerSurvival(reg: Registrar): void {
  reg({
    name: "autoeat_set_enabled",
    group: "survival",
    description:
      "Enable or disable the automatic eating behavior (eats when hunger/health drop below the configured thresholds).",
    inputSchema: {
      enabled: z.boolean().describe("true to enable auto-eating, false to disable"),
    },
    annotations: { title: "Set auto-eat enabled" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const autoEat = (bot as any).autoEat;
      if (args.enabled) autoEat.enableAuto();
      else autoEat.disableAuto();
      return { ok: true, enabled: autoEat.enabled };
    },
  });

  reg({
    name: "autoeat_configure",
    group: "survival",
    description:
      "Configure auto-eat options. Only the provided fields are changed. priority selects how food is ranked; minHunger/minHealth are the thresholds that trigger auto-eating; bannedFood lists item names to never eat.",
    inputSchema: {
      priority: priorityEnum.optional().describe("How candidate foods are ranked"),
      minHunger: z.number().optional().describe("Eat automatically when hunger is at or below this (0-20)"),
      minHealth: z.number().optional().describe("Eat automatically when health is at or below this (0-20)"),
      bannedFood: z.array(z.string()).optional().describe("Item names to never eat"),
      returnToLastItem: z.boolean().optional().describe("Re-equip the previously held item after eating"),
      offhand: z.boolean().optional().describe("Eat from the off-hand slot"),
      eatingTimeout: z.number().optional().describe("Max ms to wait for an eat to complete"),
      strictErrors: z.boolean().optional().describe("Throw on recoverable errors instead of swallowing them"),
    },
    annotations: { title: "Configure auto-eat" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const autoEat = (bot as any).autoEat;
      const opts: Record<string, unknown> = {};
      if (args.priority !== undefined) opts.priority = args.priority;
      if (args.minHunger !== undefined) opts.minHunger = args.minHunger;
      if (args.minHealth !== undefined) opts.minHealth = args.minHealth;
      if (args.bannedFood !== undefined) opts.bannedFood = args.bannedFood;
      if (args.returnToLastItem !== undefined) opts.returnToLastItem = args.returnToLastItem;
      if (args.offhand !== undefined) opts.offhand = args.offhand;
      if (args.eatingTimeout !== undefined) opts.eatingTimeout = args.eatingTimeout;
      if (args.strictErrors !== undefined) opts.strictErrors = args.strictErrors;
      autoEat.setOpts(opts);
      return { ok: true, opts: autoEat.opts };
    },
  });

  reg({
    name: "autoeat_eat",
    group: "survival",
    description:
      "Eat a food item once, now. Optionally specify which food; otherwise the best available food is chosen by the current priority. Throws MISSING_ITEM when no suitable food is available.",
    inputSchema: {
      food: itemRef.optional().describe("Specific food item to eat (name or id); omit to auto-select"),
      offhand: z.boolean().optional().describe("Eat from the off-hand slot"),
      equipOldItem: z.boolean().optional().describe("Re-equip the previously held item after eating"),
      priority: priorityEnum.optional().describe("Override the ranking used to pick a food"),
    },
    annotations: { title: "Eat now" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const autoEat = (bot as any).autoEat;
      try {
        await autoEat.eat({
          food: args.food as any,
          offhand: args.offhand,
          equipOldItem: args.equipOldItem,
          priority: args.priority,
        });
        return { ok: true };
      } catch (e) {
        if (e instanceof ToolError) throw e;
        throw new ToolError(
          "MISSING_ITEM",
          `Could not eat: ${String((e as Error)?.message ?? e)}`,
          ["Ensure the bot has edible food in its inventory.", "Use `autoeat_preview` to see ranked food choices."],
        );
      }
    },
  });

  reg({
    name: "autoeat_cancel",
    group: "survival",
    description: "Cancel an in-progress eat started by autoeat_eat or the auto behavior.",
    inputSchema: {},
    annotations: { title: "Cancel eating" },
    handler: (_args, ctx) => {
      const bot = ctx.manager.requireBot();
      (bot as any).autoEat.cancelEat();
      return { ok: true };
    },
  });

  reg({
    name: "autoeat_preview",
    group: "survival",
    description:
      "Preview which inventory foods would be chosen, ranked best-first, under the given (or current) priority. Read-only.",
    inputSchema: {
      priority: priorityEnum.optional().describe("Ranking to use; defaults to the configured priority"),
    },
    annotations: { readOnlyHint: true, title: "Preview food choices" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const autoEat = (bot as any).autoEat;
      const items = bot.inventory.items();
      const ranked = autoEat.findBestChoices(items, args.priority ?? autoEat.opts.priority);
      return { choices: ranked.map((i: any) => i.name) };
    },
  });

  reg({
    name: "armor_equip_all",
    group: "survival",
    description: "Automatically equip the best available armor pieces from the bot's inventory.",
    inputSchema: {},
    annotations: { title: "Equip all armor" },
    handler: async (_args, ctx) => {
      const bot = ctx.manager.requireBot();
      await (bot as any).armorManager.equipAll();
      return { ok: true };
    },
  });
}
