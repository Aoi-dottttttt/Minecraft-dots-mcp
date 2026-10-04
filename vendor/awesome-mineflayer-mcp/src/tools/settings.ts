/** Client game settings tools. */

import { z } from "zod";
import type { Registrar } from "./registry.js";

export function registerSettings(reg: Registrar): void {
  reg({
    name: "set_settings",
    group: "settings",
    description:
      "Update the bot's client-side game settings (view distance, chat level, main hand, skin parts, etc.) via bot.setSettings. Only the fields you provide are changed. Returns the resulting bot.settings.",
    inputSchema: {
      viewDistance: z
        .union([z.enum(["far", "normal", "short", "tiny"]), z.number()])
        .optional()
        .describe('Named distance ("far"|"normal"|"short"|"tiny") or a numeric chunk radius'),
      chat: z.enum(["enabled", "commandsOnly", "disabled"]).optional().describe("Chat visibility level"),
      colorsEnabled: z.boolean().optional().describe("Whether chat colors are enabled"),
      difficulty: z.number().optional().describe("Client difficulty value"),
      skinParts: z
        .record(z.string(), z.boolean())
        .optional()
        .describe("Map of skin part toggles, e.g. { showCape: true, showJacket: false }"),
      mainHand: z.enum(["left", "right"]).optional().describe("Dominant hand"),
      enableTextFiltering: z.boolean().optional().describe("Enable server-side text filtering"),
      enableServerListing: z.boolean().optional().describe("Allow appearing in the server player listing"),
    },
    annotations: { title: "Set game settings" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const partial: Record<string, unknown> = {};
      if (args.viewDistance !== undefined) partial.viewDistance = args.viewDistance;
      if (args.chat !== undefined) partial.chat = args.chat;
      if (args.colorsEnabled !== undefined) partial.colorsEnabled = args.colorsEnabled;
      if (args.difficulty !== undefined) partial.difficulty = args.difficulty;
      if (args.skinParts !== undefined) partial.skinParts = args.skinParts;
      if (args.mainHand !== undefined) partial.mainHand = args.mainHand;
      if (args.enableTextFiltering !== undefined) partial.enableTextFiltering = args.enableTextFiltering;
      if (args.enableServerListing !== undefined) partial.enableServerListing = args.enableServerListing;
      bot.setSettings(partial as any);
      return { ok: true, settings: bot.settings };
    },
  });
}
