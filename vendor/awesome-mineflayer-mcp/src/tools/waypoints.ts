/** Persistent named waypoints + navigate-to-waypoint. */

import { z } from "zod";
import pathfinderPkg from "mineflayer-pathfinder";
const { goals } = pathfinderPkg;
import type { Registrar } from "./registry.js";
import { ToolError } from "../util/errors.js";
import { serializeVec3 } from "../util/serialize.js";
import { DEFAULT_ACTION_TIMEOUT_MS } from "../config.js";
import { loadWaypoints, saveWaypoints, type Waypoint } from "../waypoints.js";

export function registerWaypoints(reg: Registrar): void {
  reg({
    name: "set_waypoint",
    group: "waypoints",
    description:
      "Save a named waypoint (persisted to disk, survives restarts). Omit x/y/z to capture the bot's current position. Re-using a name overwrites it.",
    inputSchema: {
      name: z.string().min(1).describe("Waypoint name, e.g. \"home\", \"diamond_mine\""),
      x: z.number().optional().describe("X (defaults to current position)"),
      y: z.number().optional().describe("Y (defaults to current position)"),
      z: z.number().optional().describe("Z (defaults to current position)"),
      note: z.string().optional().describe("Optional note about this place"),
    },
    annotations: { title: "Set waypoint" },
    handler: (args, ctx) => {
      let x = args.x;
      let y = args.y;
      let z = args.z;
      let dimension: string | null = null;
      if (x === undefined || y === undefined || z === undefined) {
        const bot = ctx.manager.requireBot();
        const p = bot.entity?.position;
        if (!p) throw new ToolError("NOT_CONNECTED", "No position available; pass x/y/z or connect first.");
        x = x ?? Math.round(p.x);
        y = y ?? Math.round(p.y);
        z = z ?? Math.round(p.z);
        dimension = bot.game?.dimension ?? null;
      } else {
        dimension = ctx.manager.botOrNull()?.game?.dimension ?? null;
      }
      const wp: Waypoint = { name: args.name, x, y, z, dimension, ...(args.note ? { note: args.note } : {}) };
      const map = loadWaypoints();
      map[args.name] = wp;
      saveWaypoints(map);
      return { ok: true, waypoint: wp };
    },
  });

  reg({
    name: "list_waypoints",
    group: "waypoints",
    description: "List all saved waypoints.",
    inputSchema: {},
    annotations: { readOnlyHint: true, title: "List waypoints" },
    handler: () => {
      const map = loadWaypoints();
      const waypoints = Object.values(map);
      return { count: waypoints.length, waypoints };
    },
  });

  reg({
    name: "delete_waypoint",
    group: "waypoints",
    description: "Delete a saved waypoint by name.",
    inputSchema: { name: z.string().min(1).describe("Waypoint name to delete") },
    annotations: { title: "Delete waypoint" },
    handler: (args) => {
      const map = loadWaypoints();
      const existed = args.name in map;
      delete map[args.name];
      saveWaypoints(map);
      return { ok: true, deleted: existed };
    },
  });

  reg({
    name: "goto_waypoint",
    group: "waypoints",
    description:
      "Navigate to a saved waypoint by name (pathfinds and blocks until arrival). Cancellable; throws NO_PATH if unreachable, TIMEOUT if it takes too long.",
    inputSchema: {
      name: z.string().min(1).describe("Waypoint name to travel to"),
      range: z.number().min(0).optional().describe("How close to get, in blocks (default 1)"),
      timeout: z.number().int().min(1).optional().describe("Max ms to spend navigating (default 60000)"),
    },
    annotations: { title: "Go to waypoint" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const wp = loadWaypoints()[args.name];
      if (!wp) {
        const names = Object.keys(loadWaypoints());
        throw new ToolError("NOT_FOUND", `No waypoint named "${args.name}".`, names.length ? [`Known: ${names.join(", ")}`] : ["Save one with set_waypoint first."]);
      }
      const curDim = bot.game?.dimension ?? null;
      if (wp.dimension && curDim && wp.dimension !== curDim) {
        throw new ToolError(
          "UNSUPPORTED",
          `Waypoint "${wp.name}" is in dimension ${wp.dimension} but the bot is in ${curDim}.`,
          ["Travel to the matching dimension first."],
        );
      }
      const timeoutMs = args.timeout ?? DEFAULT_ACTION_TIMEOUT_MS;
      const goal = new goals.GoalNear(wp.x, wp.y, wp.z, args.range ?? 1);
      const h = ctx.locks.begin("goto_waypoint", () => {
        try {
          bot.pathfinder.stop();
        } catch {
          /* ignore */
        }
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          bot.pathfinder.goto(goal),
          new Promise<never>((_res, rej) => {
            timer = setTimeout(() => rej(new ToolError("TIMEOUT", `goto_waypoint exceeded ${timeoutMs}ms`)), timeoutMs);
          }),
        ]);
        return { ok: true, waypoint: wp.name, arrivedAt: serializeVec3(bot.entity.position) };
      } catch (e) {
        if (h.signal.aborted) throw new ToolError("CANCELLED", "goto_waypoint was cancelled");
        if (e instanceof ToolError) {
          if (e.code === "TIMEOUT") {
            try {
              bot.pathfinder.stop();
            } catch {
              /* ignore */
            }
          }
          throw e;
        }
        const err = e as Error;
        const name = err?.name ?? "";
        const msg = String(err?.message ?? e);
        if (name === "NoPath" || name === "PathStopped" || /no path|path was stopped/i.test(msg)) {
          throw new ToolError("NO_PATH", `Could not reach waypoint "${wp.name}": ${msg || name}`);
        }
        throw new ToolError("INTERNAL", msg);
      } finally {
        if (timer) clearTimeout(timer);
        h.release();
      }
    },
  });
}
