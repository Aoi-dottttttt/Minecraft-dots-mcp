/** Combat tools (pvp plugin + raw melee). */

import { z } from "zod";
import pvpPkg from "mineflayer-pvp";
import type { Entity } from "prismarine-entity";

// CommonJS package — default-import + destructure for Node ESM compatibility.
const { MaxDamageOffset, RandomTicks } = pvpPkg;
import type { Registrar } from "./registry.js";
import { entityId } from "../schemas/common.js";
import { ToolError } from "../util/errors.js";
import { filterEntities } from "../bot/state.js";

export function registerCombat(reg: Registrar): void {
  reg({
    name: "pvp_attack",
    group: "combat",
    description:
      "Continuously attack a target entity using the pvp plugin (pathfinds into range and keeps swinging). Resolves when the target dies or is lost. Long-running and cancellable. Provide an entityId, or a `target` filter (type/name/username) to pick the nearest match.",
    inputSchema: {
      entityId: entityId.optional(),
      target: z
        .object({
          type: z.string().optional().describe('Entity type, e.g. "mob" or "player"'),
          name: z.string().optional().describe('Entity name, e.g. "zombie"'),
          username: z.string().optional().describe("Player username"),
        })
        .optional()
        .describe("Filter used to pick the nearest matching entity when entityId is omitted"),
      followRange: z.number().optional().describe("How close to get when pursuing the target"),
      attackRange: z.number().optional().describe("How close the bot must be to attack"),
    },
    annotations: { title: "PvP attack (continuous)" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      let entity: Entity | undefined;
      if (args.entityId !== undefined) {
        entity = bot.entities[args.entityId];
        if (!entity) throw new ToolError("NOT_FOUND", `No entity with id ${args.entityId} is currently tracked.`);
      } else {
        const matches = filterEntities(bot, {
          type: args.target?.type,
          name: args.target?.name,
          username: args.target?.username,
        });
        entity = matches[0];
        if (!entity)
          throw new ToolError("NOT_FOUND", "No entity matched the given target filter.", [
            "Use list_entities to find a valid target.",
          ]);
      }
      if (args.followRange !== undefined) bot.pvp.followRange = args.followRange;
      if (args.attackRange !== undefined) bot.pvp.attackRange = args.attackRange;

      const target = entity;
      const h = ctx.locks.begin("pvp_attack", () => {
        try {
          bot.pvp.forceStop();
        } catch {
          /* best effort */
        }
      });
      try {
        await bot.pvp.attack(target);
        // pvp.attack() resolves once pursuit begins, NOT when the fight ends.
        // Real completion is the 'stoppedAttacking' event (target dead/lost or
        // stop()/forceStop()), so wait for that (or cancellation) before returning.
        await new Promise<void>((resolve) => {
          const bus = bot as unknown as {
            once: (e: string, cb: () => void) => void;
            removeListener: (e: string, cb: () => void) => void;
          };
          if (h.signal.aborted || bot.pvp.target == null) {
            resolve();
            return;
          }
          const done = (): void => {
            bus.removeListener("stoppedAttacking", done);
            h.signal.removeEventListener("abort", done);
            resolve();
          };
          bus.once("stoppedAttacking", done);
          h.signal.addEventListener("abort", done);
        });
        return { ok: true, target: target.id };
      } catch (e) {
        if (h.signal.aborted) throw new ToolError("CANCELLED", "pvp_attack was cancelled.");
        throw e instanceof ToolError ? e : new ToolError("INTERNAL", String((e as Error)?.message ?? e));
      } finally {
        h.release();
      }
    },
  });

  reg({
    name: "attack_entity",
    group: "combat",
    description:
      "Perform a single melee attack swing against a tracked entity (one-shot; does not pathfind or repeat). Use pvp_attack for sustained combat.",
    inputSchema: {
      entityId,
      swing: z.boolean().optional().describe("Whether to play the arm swing animation (default true)"),
    },
    annotations: { title: "Attack entity (single swing)" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const e = bot.entities[args.entityId];
      if (!e) throw new ToolError("NOT_FOUND", `No entity with id ${args.entityId} is currently tracked.`);
      (bot.attack as unknown as (entity: Entity, swing?: boolean) => void)(e, args.swing ?? true);
      return { ok: true, target: args.entityId };
    },
  });

  reg({
    name: "pvp_stop",
    group: "combat",
    description:
      "Stop the current pvp attack. By default stops gracefully; pass force to hard-stop the pathfinder. Also cancels the active long-running action lock.",
    inputSchema: {
      force: z.boolean().optional().describe("Hard-stop the pathfinder (may cause falls/failed jumps)"),
    },
    annotations: { title: "Stop PvP" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      if (args.force) {
        bot.pvp.forceStop();
      } else {
        await bot.pvp.stop();
      }
      ctx.locks.cancelAll("manual");
      return { ok: true };
    },
  });

  reg({
    name: "pvp_configure",
    group: "combat",
    description:
      "Configure pvp plugin parameters: followRange, attackRange, viewDistance, and meleeMode ('maxDamage' waits for the weapon cooldown for max damage; 'fast' attacks as quickly as possible). Returns the current numeric config.",
    inputSchema: {
      followRange: z.number().optional().describe("How close to get when pursuing the target"),
      attackRange: z.number().optional().describe("How close the bot must be to attack"),
      viewDistance: z.number().optional().describe("Distance beyond which the target is considered lost"),
      meleeMode: z
        .enum(["maxDamage", "fast"])
        .optional()
        .describe("Attack timing strategy"),
    },
    annotations: { title: "Configure PvP" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      if (args.followRange !== undefined) bot.pvp.followRange = args.followRange;
      if (args.attackRange !== undefined) bot.pvp.attackRange = args.attackRange;
      if (args.viewDistance !== undefined) bot.pvp.viewDistance = args.viewDistance;
      if (args.meleeMode !== undefined) {
        bot.pvp.meleeAttackRate = args.meleeMode === "fast" ? new RandomTicks() : new MaxDamageOffset();
      }
      return {
        ok: true,
        config: {
          followRange: bot.pvp.followRange,
          attackRange: bot.pvp.attackRange,
          viewDistance: bot.pvp.viewDistance,
        },
      };
    },
  });
}
