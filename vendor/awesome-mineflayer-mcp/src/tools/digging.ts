/** Digging & building tools. */

import { z } from "zod";
import { Vec3 } from "vec3";
import type { Registrar } from "./registry.js";
import { coordsShape, itemRef } from "../schemas/common.js";
import { ToolError } from "../util/errors.js";
import { resolveItem } from "../util/resolve.js";

export function registerDigging(reg: Registrar): void {
  reg({
    name: "dig",
    group: "digging",
    description:
      "Dig (break) the block at a world coordinate, equipping the best tool automatically. Set `action:\"stop\"` to abort the current dig. This is a cancellable long-running action.",
    inputSchema: {
      ...coordsShape,
      forceLook: z
        .union([z.boolean(), z.literal("ignore")])
        .optional()
        .describe('Look at the block before digging; "ignore" to skip looking. Default true.'),
      digFace: z
        .string()
        .optional()
        .describe('Face to dig from: "auto", "raycast", or a vector. Default "auto".'),
      action: z
        .enum(["start", "stop"])
        .optional()
        .describe('"start" (default) begins digging; "stop" aborts the current dig.'),
    },
    annotations: { title: "Dig block" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      if (args.action === "stop") {
        bot.stopDigging();
        return { ok: true, stopped: true };
      }
      const block = bot.blockAt(new Vec3(args.x, args.y, args.z));
      if (!block || block.name === "air") {
        throw new ToolError("NOT_FOUND", `No diggable block at (${args.x}, ${args.y}, ${args.z}).`);
      }
      const b = bot as any;
      if (b.canDigBlock && !b.canDigBlock(block)) {
        throw new ToolError("UNSUPPORTED", `cannot dig ${block.name} (out of reach or unbreakable)`);
      }
      const h = ctx.locks.begin("dig", () => {
        try {
          bot.stopDigging();
        } catch {
          /* ignore */
        }
      });
      try {
        const forceLook = args.forceLook ?? true;
        if (args.digFace !== undefined) {
          await bot.dig(block, forceLook, args.digFace as any);
        } else {
          await bot.dig(block, forceLook);
        }
        return { ok: true, dug: block.name };
      } catch (e) {
        if (h.signal.aborted) throw new ToolError("CANCELLED", "dig was cancelled");
        throw e instanceof ToolError ? e : new ToolError("INTERNAL", String((e as Error)?.message ?? e));
      } finally {
        h.release();
      }
    },
  });

  reg({
    name: "place_block",
    group: "digging",
    description:
      "Place a block (or entity, e.g. boat/minecart) against a reference block's face. Equips `itemName` first if given. faceVector is the unit direction from the reference block toward the new block.",
    inputSchema: {
      referenceX: z.number().describe("Reference block X"),
      referenceY: z.number().describe("Reference block Y"),
      referenceZ: z.number().describe("Reference block Z"),
      faceVector: z
        .object({ x: z.number(), y: z.number(), z: z.number() })
        .describe("Unit face direction, e.g. {x:0,y:1,z:0} for the top face"),
      itemName: itemRef.optional().describe("Item to equip to hand before placing"),
      asEntity: z.boolean().optional().describe("Place an entity instead of a block (default false)"),
    },
    annotations: { title: "Place block" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      if (args.itemName !== undefined) {
        const resolved = resolveItem(bot.registry as any, args.itemName);
        await bot.equip(resolved.id, "hand");
      }
      const ref = bot.blockAt(new Vec3(args.referenceX, args.referenceY, args.referenceZ));
      if (!ref) {
        throw new ToolError(
          "NOT_FOUND",
          `No reference block at (${args.referenceX}, ${args.referenceY}, ${args.referenceZ}).`,
        );
      }
      const face = new Vec3(args.faceVector.x, args.faceVector.y, args.faceVector.z);
      if (args.asEntity) {
        await bot.placeEntity(ref, face);
      } else {
        await bot.placeBlock(ref, face);
      }
      return { ok: true };
    },
  });

  reg({
    name: "activate_block",
    group: "digging",
    description:
      "Right-click / activate the block at a coordinate (buttons, levers, doors, chests-as-interaction, etc.).",
    inputSchema: {
      ...coordsShape,
      direction: z
        .object({ x: z.number(), y: z.number(), z: z.number() })
        .optional()
        .describe("Face direction to interact from"),
      cursorPos: z
        .object({ x: z.number(), y: z.number(), z: z.number() })
        .optional()
        .describe("Cursor position on the block face"),
    },
    annotations: { title: "Activate block" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const block = bot.blockAt(new Vec3(args.x, args.y, args.z));
      if (!block) {
        throw new ToolError("NOT_FOUND", `No block at (${args.x}, ${args.y}, ${args.z}).`);
      }
      await bot.activateBlock(
        block,
        args.direction ? new Vec3(args.direction.x, args.direction.y, args.direction.z) : undefined,
        args.cursorPos ? new Vec3(args.cursorPos.x, args.cursorPos.y, args.cursorPos.z) : undefined,
      );
      return { ok: true };
    },
  });

  reg({
    name: "activate_entity",
    group: "digging",
    description:
      "Right-click / interact with a tracked entity (e.g. trade with a villager, mount a vehicle). Use `useHeldItem` to use the held item on it, or `position` to interact at a specific point.",
    inputSchema: {
      entityId: z.number().int().describe("Entity network id"),
      position: z
        .object({ x: z.number(), y: z.number(), z: z.number() })
        .optional()
        .describe("Interact at this point on the entity"),
      useHeldItem: z.boolean().optional().describe("Use the held item on the entity"),
    },
    annotations: { title: "Activate entity" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const e = bot.entities[args.entityId];
      if (!e) throw new ToolError("NOT_FOUND", `No entity id ${args.entityId}`);
      if (args.useHeldItem) {
        await bot.useOn(e);
      } else if (args.position) {
        await bot.activateEntityAt(e, new Vec3(args.position.x, args.position.y, args.position.z));
      } else {
        await bot.activateEntity(e);
      }
      return { ok: true };
    },
  });

  reg({
    name: "swing_arm",
    group: "digging",
    description: "Play the arm-swing animation (cosmetic / to trigger left-click interactions).",
    inputSchema: {
      hand: z.enum(["left", "right"]).optional().describe("Which arm to swing (default right)"),
      showHand: z.boolean().optional().describe("Whether to show the hand (default true)"),
    },
    annotations: { title: "Swing arm" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      bot.swingArm(args.hand, args.showHand);
      return { ok: true };
    },
  });
}
