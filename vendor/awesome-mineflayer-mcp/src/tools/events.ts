/** Event buffer + generic task cancellation. */

import { z } from "zod";
import type { Registrar } from "./registry.js";

export function registerEvents(reg: Registrar): void {
  reg({
    name: "get_events",
    group: "events",
    description:
      "Drain buffered game events (chat, deaths, block/entity changes, goal_reached, etc.). Pass the returned `nextSince` on the next call to read only new events without gaps. `dropped:true` means the buffer overflowed and some events between your `since` and now were lost.",
    inputSchema: {
      since: z
        .number()
        .int()
        .optional()
        .describe("Return only events with seq greater than this (from a prior nextSince)"),
      types: z
        .array(z.string())
        .optional()
        .describe('Restrict to these event types, e.g. ["chat","death","goal_reached"]'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Max events to return this call (oldest first); call again with the returned nextSince to get the rest"),
    },
    annotations: { readOnlyHint: true, title: "Get events" },
    handler: (args, ctx) => {
      const { events, nextSince, dropped } = ctx.events.drain({
        since: args.since,
        types: args.types,
        limit: args.limit,
      });
      return { count: events.length, nextSince, dropped, events };
    },
  });

  reg({
    name: "cancel_task",
    group: "events",
    description:
      "Cancel the bot's current long-running action (goto, dig, collect_block, pvp_attack, fish, smelt_item, craft_item). Returns whether something was actually cancelled.",
    inputSchema: {},
    annotations: { title: "Cancel current task" },
    handler: (_args, ctx) => {
      const wasRunning = ctx.locks.current;
      const cancelled = ctx.locks.cancelAll("manual");
      return { cancelled, task: wasRunning ?? null };
    },
  });
}
