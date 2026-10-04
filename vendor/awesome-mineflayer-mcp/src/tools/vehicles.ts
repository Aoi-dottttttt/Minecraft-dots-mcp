/** Vehicle tools: mount, dismount, and steer rideable entities (boats, minecarts, horses). */

import { z } from "zod";
import type { Registrar } from "./registry.js";
import { entityId } from "../schemas/common.js";
import { ToolError } from "../util/errors.js";

export function registerVehicles(reg: Registrar): void {
  reg({
    name: "mount_entity",
    group: "vehicles",
    description:
      "Mount a rideable entity (boat, minecart, horse, etc.) identified by its network id.",
    inputSchema: { entityId },
    annotations: { title: "Mount entity" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const e = bot.entities[args.entityId];
      if (!e) throw new ToolError("NOT_FOUND", `No entity with id ${args.entityId} is currently tracked.`);
      bot.mount(e);
      return { ok: true, entityId: args.entityId };
    },
  });

  reg({
    name: "dismount",
    group: "vehicles",
    description: "Dismount from the vehicle the bot is currently riding.",
    inputSchema: {},
    annotations: { title: "Dismount" },
    handler: (_args, ctx) => {
      const bot = ctx.manager.requireBot();
      bot.dismount();
      return { ok: true };
    },
  });

  reg({
    name: "steer_vehicle",
    group: "vehicles",
    description:
      "Steer the currently-mounted vehicle. `left` and `forward` range from -1 to 1 (e.g. forward=1 to go ahead, left=-1 to turn right).",
    inputSchema: {
      left: z.number().min(-1).max(1).describe("Sideways steering input, -1 (right) to 1 (left)"),
      forward: z.number().min(-1).max(1).describe("Forward/backward steering input, -1 (back) to 1 (forward)"),
    },
    annotations: { title: "Steer vehicle" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      bot.moveVehicle(args.left, args.forward);
      return { ok: true, left: args.left, forward: args.forward };
    },
  });
}
