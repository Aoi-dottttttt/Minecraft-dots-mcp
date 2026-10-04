/** Villager trading tools. */

import { z } from "zod";
import type { Registrar } from "./registry.js";
import { entityId } from "../schemas/common.js";
import { ToolError } from "../util/errors.js";
import { serializeItem } from "../util/serialize.js";
import { DEFAULT_ACTION_TIMEOUT_MS } from "../config.js";

export function registerVillager(reg: Registrar): void {
  reg({
    name: "open_villager",
    group: "villager",
    description:
      "Walk up to and open trading with a villager entity (by id). Returns the list of trades with their input/output items, indices, disabled flag and max uses. Use trade_with_villager to execute a trade.",
    inputSchema: {
      entityId,
    },
    annotations: { title: "Open villager" },
    timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const e = bot.entities[args.entityId];
      if (!e) throw new ToolError("NOT_FOUND", `No entity with id ${args.entityId} is currently tracked.`);
      const villager = await bot.openVillager(e);
      ctx.windows.set("villager", villager);

      // Trades can arrive a tick after the window opens; wait briefly if empty.
      if (!villager.trades || villager.trades.length === 0) {
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = (): void => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try {
              (villager as any).removeListener?.("ready", finish);
            } catch {
              /* ignore */
            }
            resolve();
          };
          const timer = setTimeout(finish, 1000);
          try {
            (villager as any).once?.("ready", finish);
          } catch {
            finish();
          }
        });
      }

      const trades = (villager.trades ?? []).map((t, i) => ({
        index: i,
        inputs: [serializeItem(t.inputItem1), t.inputItem2 ? serializeItem(t.inputItem2) : null],
        output: serializeItem(t.outputItem),
        disabled: t.tradeDisabled ?? false,
        maxUses: t.maximumNbTradeUses ?? null,
        uses: t.nbTradeUses ?? null,
      }));
      return { trades };
    },
  });

  reg({
    name: "trade_with_villager",
    group: "villager",
    description:
      "Execute a trade with the currently-open villager by trade index (from open_villager). `times` runs the trade repeatedly. Requires an open villager window.",
    inputSchema: {
      tradeIndex: z.number().int().describe("Index of the trade to execute (from open_villager)"),
      times: z.number().int().min(1).optional().describe("How many times to perform the trade (default 1)"),
    },
    annotations: { title: "Trade with villager" },
    timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const villager = ctx.windows.requireVillager();
      const times = args.times ?? 1;
      await bot.trade(villager, args.tradeIndex, times);
      return { ok: true, tradeIndex: args.tradeIndex, times };
    },
  });
}
