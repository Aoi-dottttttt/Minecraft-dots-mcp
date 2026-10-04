/** Fishing, book writing, and sign editing tools. */

import { z } from "zod";
import { Vec3 } from "vec3";
import type { Registrar } from "./registry.js";
import { coordsShape } from "../schemas/common.js";
import { ToolError } from "../util/errors.js";

export function registerFishingBooksSigns(reg: Registrar): void {
  reg({
    name: "fish",
    group: "fishing",
    description:
      "Cast a fishing line and wait for a bite (requires a fishing rod held in hand). Resolves when a catch is reeled in. Long-running and cancellable (via cancel_task or cancel_fish).",
    inputSchema: {},
    annotations: { title: "Fish" },
    handler: async (_args, ctx) => {
      const bot = ctx.manager.requireBot();
      const h = ctx.locks.begin("fish", () => {
        try {
          bot.activateItem();
        } catch {
          /* best-effort interrupt */
        }
      });
      try {
        await bot.fish();
        return { ok: true };
      } catch (e) {
        if (h.signal.aborted) throw new ToolError("CANCELLED", "fish was cancelled");
        const msg = String((e as Error)?.message ?? e);
        if (/rod|held|hold|hand|item/i.test(msg)) {
          throw new ToolError("MISSING_ITEM", "No fishing rod is held. Equip a fishing_rod to hand first.", [
            "equip_item fishing_rod to hand",
          ]);
        }
        throw e instanceof ToolError ? e : new ToolError("INTERNAL", msg);
      } finally {
        h.release();
      }
    },
  });

  reg({
    name: "cancel_fish",
    group: "fishing",
    description:
      "Best-effort interrupt of an in-progress `fish` action. Mineflayer has no native fish abort, so this toggles item use and cancels the current task; the pending fish promise may still settle on its own.",
    inputSchema: {},
    annotations: { title: "Cancel fishing" },
    handler: (_args, ctx) => {
      const bot = ctx.manager.requireBot();
      try {
        bot.activateItem();
        bot.deactivateItem();
      } catch {
        /* best-effort */
      }
      ctx.locks.cancelAll("manual");
      return { ok: true, note: "best-effort interrupt" };
    },
  });

  reg({
    name: "write_book",
    group: "fishing",
    description:
      "Write text into a book-and-quill held/located at the given inventory slot. Each array element is one page.",
    inputSchema: {
      slot: z.number().int().describe("Inventory slot index of the writable book"),
      pages: z.array(z.string()).describe("Page contents; one string per page"),
    },
    annotations: { title: "Write book" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      await bot.writeBook(args.slot, args.pages);
      return { ok: true, pages: args.pages.length };
    },
  });

  reg({
    name: "update_sign",
    group: "fishing",
    description:
      "Edit the text on a sign block at (x,y,z). Use `back` to write the back face. Read sign text back via get_block_at.",
    inputSchema: {
      ...coordsShape,
      text: z.string().describe("The text to write on the sign"),
      back: z.boolean().optional().describe("Write the back face instead of the front (default false)"),
    },
    annotations: { title: "Update sign" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const block = bot.blockAt(new Vec3(args.x, args.y, args.z));
      if (!block) throw new ToolError("NOT_FOUND", `No block at (${args.x}, ${args.y}, ${args.z}).`);
      bot.updateSign(block, args.text, args.back);
      return { ok: true };
    },
  });
}
