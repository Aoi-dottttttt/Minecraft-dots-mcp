/**
 * Higher-level build/dig macros built on pathfinder + dig + the tool plugin.
 *
 * Each loops internally over many blocks, repositions the bot as needed, equips
 * the best tool, and is mutually-exclusive + cancellable via the action lock
 * (supersede with a new long action, or cancel_task). They report how many
 * blocks were dug/placed/skipped/failed so a partial result is still useful.
 */

import { z } from "zod";
import { Vec3 } from "vec3";
import pathfinderPkg from "mineflayer-pathfinder";
const { goals } = pathfinderPkg;
import type { Bot } from "mineflayer";
import type { Registrar } from "./registry.js";
import type { ToolContext } from "../context.js";
import { ToolError } from "../util/errors.js";
import { resolveItem } from "../util/resolve.js";
import { withTimeout } from "../util/async.js";
import { DEFAULT_ACTION_TIMEOUT_MS } from "../config.js";

const HARD_CAP = 20_000; // max cells we'll enumerate for a single macro
const coord = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() });

type Dir = "north" | "south" | "east" | "west" | "forward";

function dirVector(dir: Dir, bot: Bot): { dx: number; dz: number } {
  if (dir === "north") return { dx: 0, dz: -1 };
  if (dir === "south") return { dx: 0, dz: 1 };
  if (dir === "east") return { dx: 1, dz: 0 };
  if (dir === "west") return { dx: -1, dz: 0 };
  // forward: nearest cardinal to the bot's facing
  const yaw = bot.entity?.yaw ?? 0;
  const fdx = -Math.sin(yaw);
  const fdz = Math.cos(yaw);
  return Math.abs(fdx) >= Math.abs(fdz)
    ? { dx: fdx >= 0 ? 1 : -1, dz: 0 }
    : { dx: 0, dz: fdz >= 0 ? 1 : -1 };
}

function isSolid(block: { name: string; boundingBox?: string } | null): boolean {
  return !!block && block.name !== "air" && block.boundingBox === "block";
}

/** Dig every solid block in `coords` (closest first), repositioning + tooling as needed. */
async function clearBlocks(
  ctx: ToolContext,
  bot: Bot,
  coords: Vec3[],
  maxBlocks: number,
): Promise<Record<string, unknown>> {
  const origin = bot.entity?.position ?? new Vec3(0, 0, 0);
  coords.sort((a, b) => a.distanceSquared(origin) - b.distanceSquared(origin));

  const bb = bot as unknown as {
    canDigBlock?: (b: unknown) => boolean;
    tool?: { equipForBlock?: (b: unknown, opts: unknown) => Promise<void> };
  };
  const h = ctx.locks.begin("build", () => {
    try {
      bot.pathfinder.stop();
      bot.stopDigging();
    } catch {
      /* ignore */
    }
  });
  let dug = 0;
  let skipped = 0;
  let failed = 0;
  try {
    for (const pos of coords) {
      if (h.signal.aborted) throw new ToolError("CANCELLED", "build action was cancelled");
      if (dug >= maxBlocks) break;
      let block = bot.blockAt(pos);
      if (!isSolid(block)) {
        skipped++;
        continue;
      }
      try {
        if (bb.canDigBlock && !bb.canDigBlock(block)) {
          await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2));
          block = bot.blockAt(pos);
          if (!isSolid(block)) {
            skipped++;
            continue;
          }
        }
        if (bb.canDigBlock && !bb.canDigBlock(block)) {
          failed++;
          continue;
        }
        if (bb.tool?.equipForBlock) {
          try {
            await bb.tool.equipForBlock(block, {});
          } catch {
            /* dig anyway with whatever is held */
          }
        }
        await withTimeout(bot.dig(block!), DEFAULT_ACTION_TIMEOUT_MS, "dig");
        dug++;
      } catch {
        if (h.signal.aborted) throw new ToolError("CANCELLED", "build action was cancelled");
        failed++;
      }
    }
    return { ok: true, dug, skipped, failed, targeted: coords.length, hitLimit: dug >= maxBlocks };
  } finally {
    h.release();
  }
}

function enumerateBox(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): Vec3[] {
  const x0 = Math.min(from.x, to.x);
  const x1 = Math.max(from.x, to.x);
  const y0 = Math.min(from.y, to.y);
  const y1 = Math.max(from.y, to.y);
  const z0 = Math.min(from.z, to.z);
  const z1 = Math.max(from.z, to.z);
  const volume = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
  if (volume > HARD_CAP) {
    throw new ToolError(
      "INVALID_ARGS",
      `Region is too large (${volume} blocks > ${HARD_CAP} cap). Shrink it or split into passes.`,
    );
  }
  const out: Vec3[] = [];
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) out.push(new Vec3(x, y, z));
  return out;
}

export function registerBuild(reg: Registrar): void {
  reg({
    name: "clear_region",
    group: "build",
    description:
      "Dig out every solid block in the axis-aligned box from `from` to `to` (inclusive). Closest blocks first; the bot repositions and auto-equips tools. Stops after `maxBlocks` digs (default 256). Cancellable; reports dug/skipped/failed.",
    inputSchema: {
      from: coord.describe("One corner of the box"),
      to: coord.describe("Opposite corner of the box"),
      maxBlocks: z.number().int().min(1).max(HARD_CAP).optional().describe("Max blocks to dig this call (default 256)"),
    },
    annotations: { title: "Clear region", destructiveHint: true },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const coords = enumerateBox(args.from, args.to);
      return clearBlocks(ctx, bot, coords, args.maxBlocks ?? 256);
    },
  });

  reg({
    name: "dig_tunnel",
    group: "build",
    description:
      "Dig a straight tunnel from the bot in a horizontal direction. `length` blocks long, `width` wide (centered, default 1), `height` tall (default 2 so the bot fits). Cancellable; reports progress.",
    inputSchema: {
      direction: z.enum(["north", "south", "east", "west", "forward"]).describe("Horizontal direction to tunnel"),
      length: z.number().int().min(1).max(256).describe("How many blocks forward"),
      width: z.number().int().min(1).max(16).optional().describe("Tunnel width, centered (default 1)"),
      height: z.number().int().min(1).max(16).optional().describe("Tunnel height (default 2)"),
    },
    annotations: { title: "Dig tunnel", destructiveHint: true },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const p = bot.entity!.position;
      const sx = Math.floor(p.x);
      const sy = Math.floor(p.y);
      const sz = Math.floor(p.z);
      const { dx, dz } = dirVector(args.direction, bot);
      const W = args.width ?? 1;
      const H = args.height ?? 2;
      // perpendicular horizontal axis for width
      const px = dz === 0 ? 0 : 1;
      const pz = dx === 0 ? 0 : 1;
      const wStart = -Math.floor((W - 1) / 2);
      const coords: Vec3[] = [];
      for (let d = 1; d <= args.length; d++) {
        for (let hgt = 0; hgt < H; hgt++) {
          for (let w = 0; w < W; w++) {
            const off = wStart + w;
            coords.push(new Vec3(sx + dx * d + px * off, sy + hgt, sz + dz * d + pz * off));
          }
        }
      }
      const res = await clearBlocks(ctx, bot, coords, coords.length);
      return { ...res, direction: args.direction, length: args.length, width: W, height: H };
    },
  });

  reg({
    name: "dig_staircase",
    group: "build",
    description:
      "Dig a descending staircase from the bot in a horizontal direction: each step moves one block forward and one block down, carving a `height`-tall (default 2) opening so the bot can walk down. `depth` is how many blocks to descend. Cancellable.",
    inputSchema: {
      direction: z.enum(["north", "south", "east", "west", "forward"]).describe("Horizontal direction to descend"),
      depth: z.number().int().min(1).max(128).describe("How many blocks down to dig"),
      height: z.number().int().min(2).max(4).optional().describe("Headroom per step (default 2)"),
    },
    annotations: { title: "Dig staircase", destructiveHint: true },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const p = bot.entity!.position;
      const sx = Math.floor(p.x);
      const sy = Math.floor(p.y);
      const sz = Math.floor(p.z);
      const { dx, dz } = dirVector(args.direction, bot);
      const H = args.height ?? 2;
      const coords: Vec3[] = [];
      for (let s = 1; s <= args.depth; s++) {
        // Step s: one further along dir, one lower. Carve the column the bot walks into.
        const bx = sx + dx * s;
        const bz = sz + dz * s;
        const by = sy - s;
        for (let hgt = 0; hgt < H; hgt++) coords.push(new Vec3(bx, by + hgt, bz));
      }
      const res = await clearBlocks(ctx, bot, coords, coords.length);
      return { ...res, direction: args.direction, depth: args.depth, endsAtY: sy - args.depth };
    },
  });

  reg({
    name: "fill_region",
    group: "build",
    description:
      "Place `block` into every empty (air) cell of the axis-aligned box from `from` to `to`. Best-effort: the bot must have the material and be able to reach a supporting face — cells with no adjacent solid to build against are skipped. Stops after `maxBlocks` placements (default 256). Cancellable; reports placed/skipped/failed.",
    inputSchema: {
      from: coord.describe("One corner of the box"),
      to: coord.describe("Opposite corner of the box"),
      block: z.union([z.string(), z.number().int()]).describe('Block/item to place, e.g. "cobblestone"'),
      maxBlocks: z.number().int().min(1).max(HARD_CAP).optional().describe("Max blocks to place this call (default 256)"),
    },
    annotations: { title: "Fill region", destructiveHint: true },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const resolved = resolveItem(bot.registry as any, args.block);
      const coords = enumerateBox(args.from, args.to);
      const origin = bot.entity?.position ?? new Vec3(0, 0, 0);
      coords.sort((a, b) => a.distanceSquared(origin) - b.distanceSquared(origin));

      const FACES: Array<[number, number, number]> = [
        [0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1],
      ];
      const h = ctx.locks.begin("build", () => {
        try {
          bot.pathfinder.stop();
        } catch {
          /* ignore */
        }
      });
      let placed = 0;
      let skipped = 0;
      let failed = 0;
      try {
        for (const pos of coords) {
          if (h.signal.aborted) throw new ToolError("CANCELLED", "fill_region was cancelled");
          if (placed >= (args.maxBlocks ?? 256)) break;
          const here = bot.blockAt(pos);
          if (here && here.name !== "air") {
            skipped++;
            continue;
          }
          // Need a solid neighbor to place against.
          let ref: { x: number; y: number; z: number } | null = null;
          let face: [number, number, number] | null = null;
          for (const f of FACES) {
            const np = new Vec3(pos.x + f[0], pos.y + f[1], pos.z + f[2]);
            if (isSolid(bot.blockAt(np))) {
              ref = np;
              face = [-f[0], -f[1], -f[2]];
              break;
            }
          }
          if (!ref || !face) {
            skipped++;
            continue;
          }
          try {
            const have = bot.inventory.items().find((i) => i.name === resolved.name);
            if (!have) throw new ToolError("MISSING_ITEM", `Out of ${resolved.name}.`);
            await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3));
            await bot.equip(resolved.id, "hand");
            const refBlock = bot.blockAt(new Vec3(ref.x, ref.y, ref.z));
            if (!refBlock) {
              failed++;
              continue;
            }
            await withTimeout(
              bot.placeBlock(refBlock, new Vec3(face[0], face[1], face[2])),
              DEFAULT_ACTION_TIMEOUT_MS,
              "place_block",
            );
            placed++;
          } catch (e) {
            if (h.signal.aborted) throw new ToolError("CANCELLED", "fill_region was cancelled");
            if (e instanceof ToolError && e.code === "MISSING_ITEM") throw e;
            failed++;
          }
        }
        return { ok: true, placed, skipped, failed, targeted: coords.length, block: resolved.name };
      } finally {
        h.release();
      }
    },
  });
}
