/** Shared Zod fragments. Tools pass *raw shapes* to registerTool (SDK 1.29). */

import { z } from "zod";

export const formatEnum = z.enum(["concise", "detailed"]);

/** Raw-shape fragment for an absolute world coordinate. Spread into a tool shape. */
export const coordsShape = {
  x: z.number().describe("X world coordinate (integer for blocks)"),
  y: z.number().describe("Y world coordinate (integer for blocks)"),
  z: z.number().describe("Z world coordinate (integer for blocks)"),
} as const;

/** Raw-shape fragment for an optional response detail level. */
export const formatShape = {
  format: formatEnum
    .optional()
    .describe('Response detail level; "concise" (default) or "detailed"'),
} as const;

export const Vec3Schema = z
  .object({ x: z.number(), y: z.number(), z: z.number() })
  .describe("A world coordinate {x,y,z}");

/** An item identified by human name or numeric id. */
export const itemRef = z
  .union([z.string(), z.number().int()])
  .describe('Item name (e.g. "diamond_pickaxe") or numeric item id');

/** A block identified by human name or numeric id. */
export const blockRef = z
  .union([z.string(), z.number().int()])
  .describe('Block name (e.g. "iron_ore") or numeric block id');

/** An entity identified by network id (from list_entities / find_nearest_entity). */
export const entityId = z
  .number()
  .int()
  .describe("Entity network id (obtain from list_entities / find_nearest_entity)");

export const equipDestination = z
  .enum(["hand", "head", "torso", "legs", "feet", "off-hand"])
  .describe("Equipment slot");
