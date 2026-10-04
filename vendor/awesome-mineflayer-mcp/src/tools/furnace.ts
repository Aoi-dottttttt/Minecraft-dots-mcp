/** Furnace / smelting tools. */

import { z } from "zod";
import { Vec3 } from "vec3";
import type { Registrar } from "./registry.js";
import { coordsShape, itemRef } from "../schemas/common.js";
import { ToolError } from "../util/errors.js";
import { resolveItem } from "../util/resolve.js";
import { serializeItem } from "../util/serialize.js";
import { DEFAULT_ACTION_TIMEOUT_MS } from "../config.js";

/** Compact snapshot of a furnace's three slots + fuel/smelt progress. */
function furnaceStatus(f: any): Record<string, unknown> {
  return {
    input: serializeItem(f.inputItem?.() ?? null),
    fuel: serializeItem(f.fuelItem?.() ?? null),
    output: serializeItem(f.outputItem?.() ?? null),
    fuelProgress: typeof f.fuel === "number" ? f.fuel : null,
    smeltProgress: typeof f.progress === "number" ? f.progress : null,
  };
}

export function registerFurnace(reg: Registrar): void {
  reg({
    name: "open_furnace",
    group: "furnace",
    description:
      "Open the furnace (or blast furnace / smoker) at the given coordinates and return its current contents. Keeps the window open for subsequent furnace_action / furnace_status calls.",
    inputSchema: { ...coordsShape },
    annotations: { title: "Open furnace" },
    timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const block = bot.blockAt(new Vec3(args.x, args.y, args.z));
      if (!block) {
        throw new ToolError("NOT_FOUND", `No block at (${args.x}, ${args.y}, ${args.z}).`);
      }
      const f = await bot.openFurnace(block);
      ctx.windows.set("furnace", f);
      return { ok: true, status: furnaceStatus(f) };
    },
  });

  reg({
    name: "furnace_action",
    group: "furnace",
    description:
      "Put items into, or take items out of, the currently-open furnace. `slot` selects input/fuel/output; `op` is put or take. Output cannot be put into. Requires an open furnace (open_furnace first).",
    inputSchema: {
      slot: z.enum(["input", "fuel", "output"]).describe("Which furnace slot to act on"),
      op: z.enum(["put", "take"]).describe("Put items in or take items out"),
      item: itemRef.optional().describe("Item to put (required for op=put)"),
      count: z.number().int().min(1).optional().describe("Count to put (default 1; ignored for take)"),
    },
    annotations: { title: "Furnace put/take" },
    timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const f = ctx.windows.requireFurnace();
      if (args.op === "put") {
        if (args.slot === "output") {
          throw new ToolError("INVALID_ARGS", "Cannot put items into the output slot; use op=take.");
        }
        if (args.item === undefined) {
          throw new ToolError("INVALID_ARGS", "`item` is required when op=put.");
        }
        const id = resolveItem(bot.registry as any, args.item).id;
        const count = args.count ?? 1;
        if (args.slot === "input") await f.putInput(id, null, count);
        else await f.putFuel(id, null, count);
      } else {
        if (args.slot === "input") await f.takeInput();
        else if (args.slot === "fuel") await f.takeFuel();
        else await f.takeOutput();
      }
      return { ok: true, status: furnaceStatus(f) };
    },
  });

  reg({
    name: "furnace_status",
    group: "furnace",
    description:
      "Read the currently-open furnace's input/fuel/output items and fuel/smelt progress (0..1). Requires an open furnace.",
    inputSchema: {},
    annotations: { readOnlyHint: true, title: "Furnace status" },
    handler: (_args, ctx) => {
      const f = ctx.windows.requireFurnace();
      return furnaceStatus(f);
    },
  });

  reg({
    name: "smelt_item",
    group: "furnace",
    description:
      "Smelt items end-to-end: open the furnace at furnacePos (or use the already-open furnace), load fuel + input, then poll until `count` outputs have been produced, fuel runs out, or the input is exhausted, collecting outputs as they appear. Cancellable. Approach: drives off the furnace `update` event with a per-wait tick timeout, re-checking progress/slots each cycle.",
    inputSchema: {
      furnacePos: z
        .object({ x: z.number(), y: z.number(), z: z.number() })
        .optional()
        .describe("Furnace block position; omit to use the already-open furnace"),
      input: itemRef.describe("Item to smelt"),
      fuel: itemRef.describe("Fuel item to load"),
      count: z.number().int().min(1).optional().describe("How many outputs to produce (default 1)"),
    },
    annotations: { title: "Smelt item" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const inputId = resolveItem(bot.registry as any, args.input).id;
      const fuelId = resolveItem(bot.registry as any, args.fuel).id;
      const want = args.count ?? 1;

      const h = ctx.locks.begin("smelt_item", () => {
        try {
          const w = ctx.windows.anyOrNull() as any;
          w?.close?.();
        } catch {
          /* ignore */
        }
      });

      let f: any = null;
      let openedHere = false;
      try {
        if (args.furnacePos) {
          const block = bot.blockAt(new Vec3(args.furnacePos.x, args.furnacePos.y, args.furnacePos.z));
          if (!block) {
            throw new ToolError(
              "NOT_FOUND",
              `No block at (${args.furnacePos.x}, ${args.furnacePos.y}, ${args.furnacePos.z}).`,
            );
          }
          f = await bot.openFurnace(block);
          ctx.windows.set("furnace", f);
          openedHere = true;
        } else {
          f = ctx.windows.requireFurnace();
        }

        // Load fuel if the furnace has none/low fuel, and load the input.
        if (!f.fuelItem?.()) {
          await f.putFuel(fuelId, null, 1);
        }
        if (!f.inputItem?.()) {
          await f.putInput(inputId, null, want);
        }

        // Wait for one furnace `update` event, capped by a tick timeout, so the
        // loop makes progress even if no event fires.
        const waitUpdate = (): Promise<void> =>
          new Promise<void>((resolve) => {
            let done = false;
            const finish = (): void => {
              if (done) return;
              done = true;
              try {
                f.removeListener?.("update", finish);
              } catch {
                /* ignore */
              }
              resolve();
            };
            try {
              f.once?.("update", finish);
            } catch {
              /* ignore */
            }
            void bot.waitForTicks(20).then(finish);
          });

        let smelted = 0;
        const maxCycles = 600; // ~ guard against an indefinite stall (600 * up-to-1s)
        let cycles = 0;
        let staleNoFuel = 0;

        while (smelted < want) {
          if (h.signal.aborted) throw new ToolError("CANCELLED", "smelt_item was cancelled");

          // Collect any finished output.
          if (f.outputItem?.()) {
            const taken: any = await f.takeOutput();
            const n = taken?.count ?? 1;
            smelted += n;
            if (smelted >= want) break;
            continue;
          }

          const hasFuel = !!f.fuelItem?.() || (typeof f.fuel === "number" && f.fuel > 0);
          const hasInput = !!f.inputItem?.();
          if (!hasInput) break; // nothing left to smelt
          if (!hasFuel) {
            staleNoFuel++;
            if (staleNoFuel > 2) break; // out of fuel, no progress possible
          } else {
            staleNoFuel = 0;
          }

          if (++cycles > maxCycles) {
            throw new ToolError("TIMEOUT", `smelt_item timed out after producing ${smelted} item(s).`);
          }
          await waitUpdate();
        }

        // Final sweep for any remaining output.
        if (smelted < want && f.outputItem?.()) {
          const taken: any = await f.takeOutput();
          smelted += taken?.count ?? 1;
        }

        return { ok: true, smelted, requested: want, status: furnaceStatus(f) };
      } catch (e) {
        if (h.signal.aborted) throw new ToolError("CANCELLED", "smelt_item was cancelled");
        throw e instanceof ToolError ? e : new ToolError("INTERNAL", String((e as Error)?.message ?? e));
      } finally {
        if (openedHere) {
          try {
            f?.close?.();
          } catch {
            /* ignore */
          }
          ctx.windows.clear();
        }
        h.release();
      }
    },
  });
}
