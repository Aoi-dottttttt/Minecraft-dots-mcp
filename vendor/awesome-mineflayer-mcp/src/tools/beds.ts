/** Bed / sleep tools. */

import { Vec3 } from "vec3";
import type { Registrar } from "./registry.js";
import { coordsShape } from "../schemas/common.js";
import { ToolError } from "../util/errors.js";

export function registerBeds(reg: Registrar): void {
  reg({
    name: "sleep",
    group: "beds",
    description:
      "Sleep in the bed at the given coordinates. Only works at night (or during a thunderstorm) with no nearby monsters, and the bed must be within reach.",
    inputSchema: {
      ...coordsShape,
    },
    annotations: { title: "Sleep in bed" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const block = bot.blockAt(new Vec3(args.x, args.y, args.z));
      if (!block) {
        throw new ToolError("NOT_FOUND", `No block at (${args.x}, ${args.y}, ${args.z}).`);
      }
      if (!bot.isABed(block)) {
        throw new ToolError("INVALID_ARGS", "Block at given coords is not a bed");
      }
      try {
        await bot.sleep(block);
      } catch (e) {
        const message = String((e as Error)?.message ?? e);
        if (/too far|not night|monster/i.test(message)) {
          throw new ToolError("UNSUPPORTED", message);
        }
        throw e instanceof ToolError ? e : new ToolError("INTERNAL", message);
      }
      return { ok: true };
    },
  });

  reg({
    name: "wake",
    group: "beds",
    description: "Wake up / get out of the bed the bot is currently sleeping in.",
    inputSchema: {},
    annotations: { title: "Wake up" },
    handler: async (_args, ctx) => {
      const bot = ctx.manager.requireBot();
      await bot.wake();
      return { ok: true };
    },
  });
}
