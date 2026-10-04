/** Look / orientation tools. */

import { z } from "zod";
import { Vec3 } from "vec3";
import type { Registrar } from "./registry.js";
import { coordsShape, entityId } from "../schemas/common.js";
import { ToolError } from "../util/errors.js";

export function registerLook(reg: Registrar): void {
  reg({
    name: "look_at",
    group: "look",
    description:
      "Aim the bot's head at a world point (x,y,z). Use `force` to snap instantly instead of turning smoothly over time.",
    inputSchema: {
      ...coordsShape,
      force: z.boolean().optional().describe("Snap instantly instead of smoothly (default false)"),
    },
    annotations: { title: "Look at point" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      await bot.lookAt(new Vec3(args.x, args.y, args.z), args.force ?? false);
      return { ok: true, lookingAt: { x: args.x, y: args.y, z: args.z } };
    },
  });

  reg({
    name: "look",
    group: "look",
    description: "Set the bot's absolute head orientation in radians (yaw, pitch).",
    inputSchema: {
      yaw: z.number().describe("Yaw in radians (0 = south, increases clockwise)"),
      pitch: z.number().describe("Pitch in radians (-PI/2 = straight up, +PI/2 = straight down)"),
      force: z.boolean().optional().describe("Snap instantly instead of smoothly (default false)"),
    },
    annotations: { title: "Set head orientation" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      await bot.look(args.yaw, args.pitch, args.force ?? false);
      return { ok: true, yaw: args.yaw, pitch: args.pitch };
    },
  });

  reg({
    name: "look_at_entity",
    group: "look",
    description:
      "Aim the bot's head at a tracked entity (by id), targeting its approximate eye height. Re-call to keep tracking a moving target.",
    inputSchema: {
      entityId,
      force: z.boolean().optional().describe("Snap instantly instead of smoothly (default false)"),
    },
    annotations: { title: "Look at entity" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const e = bot.entities[args.entityId];
      if (!e) throw new ToolError("NOT_FOUND", `No entity with id ${args.entityId} is currently tracked.`);
      const height = (e as { height?: number }).height ?? 1.8;
      await bot.lookAt(e.position.offset(0, height * 0.9, 0), args.force ?? false);
      return { ok: true, entityId: args.entityId };
    },
  });
}
