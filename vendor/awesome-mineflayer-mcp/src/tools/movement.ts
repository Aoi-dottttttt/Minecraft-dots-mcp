/** Movement & pathfinding tools. */

import { z } from "zod";
import { Vec3 } from "vec3";
import pathfinderPkg from "mineflayer-pathfinder";
import type * as PF from "mineflayer-pathfinder";
import type { Bot } from "mineflayer";

// CommonJS package — default-import + destructure for Node ESM compatibility.
// Runtime values come from the destructure; types come from the `PF` namespace.
const { goals, Movements } = pathfinderPkg;
import type { Registrar } from "./registry.js";
import { coordsShape, entityId } from "../schemas/common.js";
import { ToolError } from "../util/errors.js";
import { resolveBlockIds } from "../util/resolve.js";
import { serializeVec3 } from "../util/serialize.js";

/** A goal specification: a goalType plus its optional coordinate/range fields. */
interface GoalSpec {
  goalType: string;
  x?: number;
  y?: number;
  z?: number;
  range?: number;
  goals?: GoalSpec[];
}

const goalTypeEnum = z.enum([
  "block",
  "near",
  "xz",
  "nearxz",
  "y",
  "getToBlock",
  "lookAtBlock",
  "placeBlock",
  "composite_any",
  "composite_all",
  "invert",
]);

const nestedGoalSchema = z.object({
  goalType: z.string(),
  x: z.number().optional(),
  y: z.number().optional(),
  z: z.number().optional(),
  range: z.number().optional(),
});

/** Raw-shape fragment shared by every goal-building tool. */
const goalShape = {
  goalType: goalTypeEnum.describe("Which kind of pathfinder goal to build"),
  x: z.number().optional().describe("Target X (required for most goal types)"),
  y: z.number().optional().describe("Target Y"),
  z: z.number().optional().describe("Target Z"),
  range: z.number().optional().describe("Acceptable distance from the target (for near/nearxz/follow)"),
  goals: z
    .array(nestedGoalSchema)
    .optional()
    .describe("Nested goals for composite_any/composite_all/invert"),
} as const;

function reqNum(v: number | undefined, field: string, goalType: string): number {
  if (typeof v !== "number") {
    throw new ToolError("INVALID_ARGS", `goalType "${goalType}" requires a numeric "${field}".`);
  }
  return v;
}

/** Build a pathfinder Goal instance from a spec (recursive for composite/invert). */
function buildGoal(spec: GoalSpec, bot: Bot): PF.goals.Goal {
  const t = spec.goalType;
  switch (t) {
    case "block":
      return new goals.GoalBlock(reqNum(spec.x, "x", t), reqNum(spec.y, "y", t), reqNum(spec.z, "z", t));
    case "near":
      return new goals.GoalNear(reqNum(spec.x, "x", t), reqNum(spec.y, "y", t), reqNum(spec.z, "z", t), spec.range ?? 1);
    case "xz":
      return new goals.GoalXZ(reqNum(spec.x, "x", t), reqNum(spec.z, "z", t));
    case "nearxz":
      return new goals.GoalNearXZ(reqNum(spec.x, "x", t), reqNum(spec.z, "z", t), spec.range ?? 1);
    case "y":
      return new goals.GoalY(reqNum(spec.y, "y", t));
    case "getToBlock":
      return new goals.GoalGetToBlock(reqNum(spec.x, "x", t), reqNum(spec.y, "y", t), reqNum(spec.z, "z", t));
    case "lookAtBlock":
      return new goals.GoalLookAtBlock(
        new Vec3(reqNum(spec.x, "x", t), reqNum(spec.y, "y", t), reqNum(spec.z, "z", t)),
        bot.world,
      );
    case "placeBlock":
      // Advanced: GoalPlaceBlock needs full placement options (range/LOS/faces/facing).
      // We pass a permissive default; for real placement use the build tools instead.
      return new goals.GoalPlaceBlock(
        new Vec3(reqNum(spec.x, "x", t), reqNum(spec.y, "y", t), reqNum(spec.z, "z", t)),
        bot.world,
        {} as any,
      );
    case "composite_any":
    case "composite_all": {
      const nested = spec.goals ?? [];
      if (nested.length === 0) {
        throw new ToolError("INVALID_ARGS", `goalType "${t}" requires a non-empty "goals" array.`);
      }
      const built = nested.map((g) => buildGoal(g, bot));
      return t === "composite_any" ? new goals.GoalCompositeAny(built) : new goals.GoalCompositeAll(built);
    }
    case "invert": {
      const nested = spec.goals ?? [];
      if (nested.length === 0) {
        throw new ToolError("INVALID_ARGS", `goalType "invert" requires a "goals" array with one nested goal.`);
      }
      return new goals.GoalInvert(buildGoal(nested[0]!, bot));
    }
    default:
      throw new ToolError("INVALID_ARGS", `Unknown goalType "${t}".`);
  }
}

export function registerMovement(reg: Registrar): void {
  reg({
    name: "goto",
    group: "movement",
    description:
      "Navigate to a goal using the pathfinder and block until arrival (or timeout). Supports block/near/xz/nearxz/y/getToBlock/lookAtBlock/placeBlock and composite_any/composite_all/invert (nested via `goals`). Cancellable; throws NO_PATH if unreachable, TIMEOUT if it takes too long.",
    inputSchema: {
      ...goalShape,
      timeout: z.number().int().min(1).optional().describe("Max ms to spend navigating (default 60000)"),
    },
    annotations: { title: "Go to goal" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const goal = buildGoal(args as GoalSpec, bot);
      const timeoutMs = args.timeout ?? 60000;
      const h = ctx.locks.begin("goto", () => {
        try {
          bot.pathfinder.stop();
        } catch {
          /* ignore */
        }
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          bot.pathfinder.goto(goal).then(() => "arrived" as const),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new ToolError("TIMEOUT", `goto exceeded ${timeoutMs}ms`)), timeoutMs);
          }),
        ]);
        void result;
        return { ok: true, arrivedAt: serializeVec3(bot.entity.position) };
      } catch (e) {
        if (h.signal.aborted) throw new ToolError("CANCELLED", "goto was cancelled");
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
        // mineflayer-pathfinder puts the failure kind in err.name (NoPath,
        // Timeout, GoalChanged, PathStopped); match name first, message as backup.
        const err = e as Error;
        const name = err?.name ?? "";
        const msg = String(err?.message ?? e);
        if (name === "NoPath" || name === "PathStopped" || /no path|path was stopped/i.test(msg)) {
          throw new ToolError("NO_PATH", `Could not reach the goal: ${msg || name}`);
        }
        if (name === "Timeout" || /took to long|timed?\s?out/i.test(msg)) {
          try {
            bot.pathfinder.stop();
          } catch {
            /* ignore */
          }
          throw new ToolError("TIMEOUT", `Pathfinding timed out: ${msg || name}`);
        }
        if (name === "GoalChanged" || /goal was changed/i.test(msg)) {
          throw new ToolError("GOAL_CHANGED", `Navigation goal changed: ${msg || name}`);
        }
        throw new ToolError("INTERNAL", msg);
      } finally {
        if (timer) clearTimeout(timer);
        h.release();
      }
    },
  });

  reg({
    name: "set_goal",
    group: "movement",
    description:
      "Set a pathfinder goal without waiting (fire-and-forget). The bot keeps moving toward it in the background. Use `dynamic` for goals that should recompute as the world/target changes.",
    inputSchema: {
      ...goalShape,
      dynamic: z.boolean().optional().describe("Recompute the path continuously (default false)"),
    },
    annotations: { title: "Set goal (async)" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const goal = buildGoal(args as GoalSpec, bot);
      bot.pathfinder.setGoal(goal, args.dynamic ?? false);
      return { ok: true };
    },
  });

  reg({
    name: "flee_from",
    group: "movement",
    description: "Continuously move away from a world point until at least `distance` blocks away (dynamic goal).",
    inputSchema: {
      ...coordsShape,
      distance: z.number().describe("Minimum distance to keep from the point"),
    },
    annotations: { title: "Flee from point" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalNear(args.x, args.y, args.z, args.distance)), true);
      return { ok: true };
    },
  });

  reg({
    name: "follow_entity",
    group: "movement",
    description: "Continuously follow a tracked entity (by id), staying within `range` blocks. Dynamic goal; persists until changed/stopped.",
    inputSchema: {
      entityId,
      range: z.number().optional().describe("Distance to keep behind the target (default 2)"),
    },
    annotations: { title: "Follow entity" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const e = bot.entities[args.entityId];
      if (!e) throw new ToolError("NOT_FOUND", `No entity with id ${args.entityId} is currently tracked.`);
      bot.pathfinder.setGoal(new goals.GoalFollow(e, args.range ?? 2), true);
      return { ok: true };
    },
  });

  reg({
    name: "stop_pathfinding",
    group: "movement",
    description: "Clear the current pathfinder goal, stop moving, and cancel any in-progress exclusive action (goto/dig/etc).",
    inputSchema: {},
    annotations: { title: "Stop pathfinding" },
    handler: (_args, ctx) => {
      const bot = ctx.manager.requireBot();
      bot.pathfinder.stop();
      ctx.locks.cancelAll("manual");
      return { ok: true };
    },
  });

  reg({
    name: "get_path_to",
    group: "movement",
    description:
      "Compute (but do not execute) a path to a goal and report its status/cost/timing without moving the bot. Useful to test reachability before committing to `goto`.",
    inputSchema: {
      ...goalShape,
      timeout: z.number().int().min(1).optional().describe("Max ms to spend computing the path"),
    },
    annotations: { readOnlyHint: true, title: "Compute path" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const goal = buildGoal(args as GoalSpec, bot);
      // Use the live configured movements profile so the computed path matches
      // what `goto` would actually execute (canDig/parkour/avoid lists, etc.).
      const movements =
        (bot.pathfinder as unknown as { movements?: PF.Movements }).movements ?? new Movements(bot);
      const r = bot.pathfinder.getPathTo(movements, goal, args.timeout);
      return {
        status: r.status,
        cost: r.cost,
        time: r.time,
        visitedNodes: r.visitedNodes,
        generatedNodes: r.generatedNodes,
        pathLength: r.path?.length,
      };
    },
  });

  reg({
    name: "configure_movements",
    group: "movement",
    description:
      "Build and apply a Movements profile (the rules governing how the bot may traverse the world: digging, parkour, towers, doors, costs, and block allow/deny lists). Applies to the pathfinder by default, or to pvp/collectblock movements via `scope`.",
    inputSchema: {
      scope: z.enum(["pathfinder", "pvp", "collectblock"]).optional().describe("Where to apply the profile (default pathfinder)"),
      canDig: z.boolean().optional(),
      digCost: z.number().optional(),
      placeCost: z.number().optional(),
      maxDropDown: z.number().optional(),
      infiniteLiquidDropdownDistance: z.boolean().optional(),
      allowParkour: z.boolean().optional(),
      allowSprinting: z.boolean().optional(),
      allow1by1towers: z.boolean().optional(),
      allowFreeMotion: z.boolean().optional(),
      canOpenDoors: z.boolean().optional(),
      dontMineUnderFallingBlock: z.boolean().optional(),
      dontCreateFlow: z.boolean().optional(),
      entityCost: z.number().optional(),
      blocksToAvoid: z.array(z.string()).optional().describe("Block names the bot should avoid stepping on"),
      blocksCantBreak: z.array(z.string()).optional().describe("Block names the bot must never break"),
      scaffoldingBlocks: z.array(z.string()).optional().describe("Block names usable as scaffolding to bridge/tower"),
    },
    annotations: { title: "Configure movements" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const m = new Movements(bot) as unknown as Record<string, unknown>;
      const registry = bot.registry as any;

      const scalarFields = [
        "canDig",
        "digCost",
        "placeCost",
        "maxDropDown",
        "infiniteLiquidDropdownDistance",
        "allowParkour",
        "allowSprinting",
        "allow1by1towers",
        "allowFreeMotion",
        "canOpenDoors",
        "dontMineUnderFallingBlock",
        "dontCreateFlow",
        "entityCost",
      ] as const;
      for (const f of scalarFields) {
        const v = (args as Record<string, unknown>)[f];
        if (v !== undefined) m[f] = v;
      }

      // Set<number> fields.
      if (args.blocksToAvoid) m.blocksToAvoid = new Set(resolveBlockIds(registry, args.blocksToAvoid));
      if (args.blocksCantBreak) m.blocksCantBreak = new Set(resolveBlockIds(registry, args.blocksCantBreak));
      // scaffolding list is `scafoldingBlocks: number[]` in pathfinder (note spelling).
      if (args.scaffoldingBlocks) m.scafoldingBlocks = resolveBlockIds(registry, args.scaffoldingBlocks);

      const scope = args.scope ?? "pathfinder";
      const b = bot as any;
      if (scope === "pvp") {
        b.pvp.movements = m;
      } else if (scope === "collectblock") {
        b.collectBlock.movements = m;
      } else {
        bot.pathfinder.setMovements(m as unknown as PF.Movements);
      }
      return { ok: true, scope };
    },
  });

  reg({
    name: "configure_pathfinder",
    group: "movement",
    description:
      "Tune pathfinder engine parameters (thinking budget per search/tick, search radius, and path-shortcut / line-of-sight placement behaviour). Returns the resulting values.",
    inputSchema: {
      thinkTimeout: z.number().optional().describe("Max ms for a full path search"),
      tickTimeout: z.number().optional().describe("Max ms of thinking per tick (<=50)"),
      searchRadius: z.number().optional().describe("Limit the search radius in blocks (-1 = unlimited)"),
      enablePathShortcut: z.boolean().optional().describe("Skip redundant nodes for smoother paths"),
      LOSWhenPlacingBlocks: z.boolean().optional().describe("Require line of sight when placing scaffolding"),
    },
    annotations: { title: "Configure pathfinder" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const pf = bot.pathfinder as any;
      if (args.thinkTimeout !== undefined) pf.thinkTimeout = args.thinkTimeout;
      if (args.tickTimeout !== undefined) pf.tickTimeout = args.tickTimeout;
      if (args.searchRadius !== undefined) pf.searchRadius = args.searchRadius;
      if (args.enablePathShortcut !== undefined) pf.enablePathShortcut = args.enablePathShortcut;
      if (args.LOSWhenPlacingBlocks !== undefined) pf.LOSWhenPlacingBlocks = args.LOSWhenPlacingBlocks;
      return {
        thinkTimeout: pf.thinkTimeout,
        tickTimeout: pf.tickTimeout,
        searchRadius: pf.searchRadius,
        enablePathShortcut: pf.enablePathShortcut,
        LOSWhenPlacingBlocks: pf.LOSWhenPlacingBlocks,
      };
    },
  });

  reg({
    name: "set_control_state",
    group: "movement",
    description:
      "Hold or release a single low-level movement control (forward/back/left/right/jump/sprint/sneak). Manual control; conflicts with active pathfinding.",
    inputSchema: {
      control: z.enum(["forward", "back", "left", "right", "jump", "sprint", "sneak"]).describe("Control to set"),
      state: z.boolean().describe("true = press/hold, false = release"),
    },
    annotations: { title: "Set control state" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      bot.setControlState(args.control, args.state);
      return { ok: true };
    },
  });

  reg({
    name: "clear_control_states",
    group: "movement",
    description: "Release all manual movement controls at once.",
    inputSchema: {},
    annotations: { title: "Clear control states" },
    handler: (_args, ctx) => {
      const bot = ctx.manager.requireBot();
      bot.clearControlStates();
      return { ok: true };
    },
  });

  reg({
    name: "elytra_fly",
    group: "movement",
    description: "Begin elytra gliding flight. Requires equipped elytra and that the bot is already gliding; otherwise fails as UNSUPPORTED.",
    inputSchema: {},
    annotations: { title: "Elytra fly" },
    handler: async (_args, ctx) => {
      const bot = ctx.manager.requireBot();
      try {
        await bot.elytraFly();
        return { ok: true };
      } catch (e) {
        throw new ToolError("UNSUPPORTED", `Could not elytra fly: ${String((e as Error)?.message ?? e)}`);
      }
    },
  });

  reg({
    name: "wait_for_ticks",
    group: "movement",
    description: "Block until the given number of game ticks have elapsed (20 ticks ~= 1 second).",
    inputSchema: {
      ticks: z.number().int().min(1).max(2400).describe("Number of game ticks to wait"),
    },
    annotations: { title: "Wait for ticks" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      await bot.waitForTicks(args.ticks);
      return { ok: true, ticks: args.ticks };
    },
  });

  reg({
    name: "set_physics_enabled",
    group: "movement",
    description: "Enable or disable the bot's client-side physics simulation. Disabling freezes movement (useful for some scripted scenarios).",
    inputSchema: {
      enabled: z.boolean().describe("true to run physics, false to freeze"),
    },
    annotations: { title: "Set physics enabled" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      bot.physicsEnabled = args.enabled;
      return { physicsEnabled: bot.physicsEnabled };
    },
  });
}
