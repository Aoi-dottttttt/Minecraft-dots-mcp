/** Read-only state inspection tools. */

import { z } from "zod";
import type { Registrar } from "./registry.js";
import { formatShape } from "../schemas/common.js";
import { ToolError } from "../util/errors.js";
import { serializeEntity } from "../util/serialize.js";
import {
  selfState,
  inventoryState,
  playersState,
  entitiesState,
  filterEntities,
  type EntityFilter,
} from "../bot/state.js";
import { loadedPlugins } from "../bot/plugins.js";

const CONTROLS = ["forward", "back", "left", "right", "jump", "sprint", "sneak"] as const;

/** Best-effort stringification of a prismarine ChatMessage / unknown value. */
function chatToString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  try {
    const maybe = v as { toString?: () => string };
    return typeof maybe.toString === "function" ? maybe.toString() : String(v);
  } catch {
    return null;
  }
}

/** Shared entity-filter shape for list/find tools. */
const entityFilterShape = {
  type: z.string().optional().describe('Entity type, e.g. "player", "mob", "object"'),
  kind: z.string().optional().describe('Entity kind, e.g. "Hostile mobs"'),
  mobType: z.string().optional().describe('Mob type/display name, e.g. "Zombie"'),
  username: z.string().optional().describe("Player username (players only)"),
  name: z.string().optional().describe('Entity name, e.g. "zombie", "item"'),
  maxDistance: z.number().min(0).optional().describe("Only entities within this many blocks"),
} as const;

export function registerStateInspect(reg: Registrar): void {
  reg({
    name: "get_state",
    group: "state",
    description:
      "Snapshot the bot's own state: position, velocity, orientation, health/food, gamemode, dimension, held item, time/weather, control state and active effects.",
    inputSchema: { ...formatShape },
    annotations: { readOnlyHint: true, title: "Get bot state" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      return selfState(bot, args.format === "detailed");
    },
  });

  reg({
    name: "get_inventory",
    group: "state",
    description:
      "List the bot's inventory: held item/slot, all carried items, armor slots, off-hand, and free/total slot counts.",
    inputSchema: { ...formatShape },
    annotations: { readOnlyHint: true, title: "Get inventory" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      return inventoryState(bot, args.format === "detailed");
    },
  });

  reg({
    name: "get_observation",
    group: "state",
    description:
      "One-call situational snapshot for an agent's observe loop: connection status, self vitals/position, held item + inventory, nearby entities, and recent/new events. Replaces calling get_state + get_inventory + list_entities + get_events separately. Pass `since` (a prior events.nextSince) to get only new events; otherwise a recent tail is returned with nextSince to start paginating.",
    inputSchema: {
      includeEntities: z.boolean().optional().describe("Include nearby entities (default true)"),
      entityRadius: z.number().min(0).optional().describe("Max distance for nearby entities (default 16)"),
      entityLimit: z.number().int().min(1).max(100).optional().describe("Max entities (default 10)"),
      includeEvents: z.boolean().optional().describe("Include events (default true)"),
      since: z.number().int().optional().describe("Only events with seq greater than this (from a prior nextSince)"),
      eventLimit: z.number().int().min(1).max(200).optional().describe("Max events (default 20)"),
      ...formatShape,
    },
    annotations: { readOnlyHint: true, title: "Get observation" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const detailed = args.format === "detailed";
      const inv = inventoryState(bot, detailed);
      const obs: Record<string, unknown> = {
        status: ctx.manager.status,
        self: selfState(bot, detailed),
        heldItem: inv.heldItem,
        heldSlot: inv.heldSlot,
        items: inv.items,
        emptySlots: inv.emptySlots,
      };
      if (args.includeEntities !== false) {
        obs.entities = entitiesState(
          bot,
          { maxDistance: args.entityRadius ?? 16 },
          args.entityLimit ?? 10,
          detailed,
        );
      }
      if (args.includeEvents !== false) {
        const eventLimit = args.eventLimit ?? 20;
        if (args.since !== undefined) {
          const d = ctx.events.drain({ since: args.since, limit: eventLimit });
          obs.events = { count: d.events.length, nextSince: d.nextSince, dropped: d.dropped, events: d.events };
        } else {
          const tail = ctx.events.recent(eventLimit);
          obs.events = { count: tail.length, nextSince: ctx.events.lastSeq, dropped: false, events: tail };
        }
      }
      return obs;
    },
  });

  reg({
    name: "list_players",
    group: "state",
    description:
      "List players currently visible in the tablist with username, display name, gamemode, ping and (if tracked) entity id/position.",
    inputSchema: {},
    annotations: { readOnlyHint: true, title: "List players" },
    handler: (_args, ctx) => {
      const bot = ctx.manager.requireBot();
      return { players: playersState(bot) };
    },
  });

  reg({
    name: "list_entities",
    group: "state",
    description:
      "List nearby tracked entities, nearest-first, filtered by type/kind/mobType/username/name and/or maxDistance.",
    inputSchema: {
      ...entityFilterShape,
      limit: z.number().int().min(1).max(200).optional().describe("Max entities to return (default 50)"),
      ...formatShape,
    },
    annotations: { readOnlyHint: true, title: "List entities" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const filter: EntityFilter = {
        type: args.type,
        kind: args.kind,
        mobType: args.mobType,
        username: args.username,
        name: args.name,
        maxDistance: args.maxDistance,
      };
      const list = entitiesState(bot, filter, args.limit ?? 50, args.format === "detailed");
      return { count: list.length, entities: list };
    },
  });

  reg({
    name: "find_nearest_entity",
    group: "state",
    description:
      "Find the single nearest tracked entity matching the given filter. Returns {found:false} if none match.",
    inputSchema: {
      ...entityFilterShape,
      ...formatShape,
    },
    annotations: { readOnlyHint: true, title: "Find nearest entity" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const filter: EntityFilter = {
        type: args.type,
        kind: args.kind,
        mobType: args.mobType,
        username: args.username,
        name: args.name,
        maxDistance: args.maxDistance,
      };
      const [e] = filterEntities(bot, filter);
      return e ? serializeEntity(e, { detailed: true, origin: bot.entity.position }) : { found: false };
    },
  });

  reg({
    name: "get_entity_details",
    group: "state",
    description: "Get full details for a single tracked entity by its network id.",
    inputSchema: {
      entityId: z.number().int().describe("Entity network id (from list_entities / find_nearest_entity)"),
    },
    annotations: { readOnlyHint: true, title: "Get entity details" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const e = bot.entities[args.entityId];
      if (!e) throw new ToolError("NOT_FOUND", `No entity with id ${args.entityId} is currently tracked.`);
      return serializeEntity(e, { detailed: true, origin: bot.entity.position });
    },
  });

  reg({
    name: "get_scoreboards",
    group: "state",
    description:
      "List active scoreboards with their name, title and items ({name,value}). Optionally filter to a single display slot.",
    inputSchema: {
      displaySlot: z
        .string()
        .optional()
        .describe('Restrict to a display slot, e.g. "sidebar", "list", "belowName"'),
    },
    annotations: { readOnlyHint: true, title: "Get scoreboards" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const b = bot as any;
      const boards: Array<Record<string, unknown>> = [];
      try {
        if (args.displaySlot) {
          const board = b.scoreboard?.[args.displaySlot];
          if (board) {
            boards.push(serializeScoreboard(board));
          }
        } else {
          for (const board of Object.values(b.scoreboards ?? {})) {
            boards.push(serializeScoreboard(board));
          }
        }
      } catch {
        /* ignore — scoreboard plugin state may be unavailable */
      }
      return { count: boards.length, scoreboards: boards };
    },
  });

  reg({
    name: "get_teams",
    group: "state",
    description:
      "List scoreboard teams with friendlyFire, nameTagVisibility, color, prefix, suffix and members. Optionally filter to one team.",
    inputSchema: {
      teamName: z.string().optional().describe("Restrict to a single team by its internal name"),
    },
    annotations: { readOnlyHint: true, title: "Get teams" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const b = bot as any;
      const teams: Array<Record<string, unknown>> = [];
      try {
        const map = b.teams ?? b.teamMap ?? {};
        const entries = args.teamName
          ? map[args.teamName]
            ? [map[args.teamName]]
            : []
          : Object.values(map);
        for (const t of entries as any[]) {
          teams.push({
            team: t.team ?? null,
            name: chatToString(t.name),
            friendlyFire: t.friendlyFire ?? null,
            nameTagVisibility: t.nameTagVisibility ?? null,
            collisionRule: t.collisionRule ?? null,
            color: t.color ?? null,
            prefix: chatToString(t.prefix),
            suffix: chatToString(t.suffix),
            members: Array.isArray(t.members) ? t.members : [],
          });
        }
      } catch {
        /* ignore */
      }
      return { count: teams.length, teams };
    },
  });

  reg({
    name: "get_boss_bars",
    group: "state",
    description: "List active boss bars with title, health, color, dividers and flags. Returns [] if none.",
    inputSchema: {},
    annotations: { readOnlyHint: true, title: "Get boss bars" },
    handler: (_args, ctx) => {
      const bot = ctx.manager.requireBot();
      const b = bot as any;
      const bars: Array<Record<string, unknown>> = [];
      try {
        const raw = b.bossBars ?? b.bossBarManager?.bossBars ?? b.bossBarManager ?? null;
        const list = raw ? (Array.isArray(raw) ? raw : Object.values(raw)) : [];
        for (const bar of list as any[]) {
          if (!bar || typeof bar !== "object") continue;
          bars.push({
            entityUUID: bar.entityUUID ?? null,
            title: chatToString(bar.title),
            health: bar.health ?? null,
            color: bar.color ?? null,
            dividers: bar.dividers ?? null,
            shouldDarkenSky: bar.shouldDarkenSky ?? null,
            isDragonBar: bar.isDragonBar ?? null,
            createFog: bar.createFog ?? bar.shouldCreateFog ?? null,
          });
        }
      } catch {
        /* ignore */
      }
      return { count: bars.length, bossBars: bars };
    },
  });

  reg({
    name: "get_control_states",
    group: "state",
    description:
      "Return the bot's seven movement control booleans: forward, back, left, right, jump, sprint, sneak.",
    inputSchema: {},
    annotations: { readOnlyHint: true, title: "Get control states" },
    handler: (_args, ctx) => {
      const bot = ctx.manager.requireBot();
      const controlState: Record<string, boolean> = {};
      for (const c of CONTROLS) {
        try {
          controlState[c] = bot.getControlState(c);
        } catch {
          controlState[c] = false;
        }
      }
      return controlState;
    },
  });

  reg({
    name: "get_chat_patterns",
    group: "state",
    description:
      "List the bot's registered chat patterns ({name?, type?, description?, pattern}). Pattern regexes are stringified.",
    inputSchema: {},
    annotations: { readOnlyHint: true, title: "Get chat patterns" },
    handler: (_args, ctx) => {
      const bot = ctx.manager.requireBot();
      const raw = ((bot as any).chatPatterns ?? []) as any[];
      const patterns = raw.map((p) => ({
        name: p.name ?? null,
        type: p.type ?? null,
        description: p.description ?? null,
        pattern: String(p.pattern),
      }));
      return { count: patterns.length, patterns };
    },
  });

  reg({
    name: "support_feature",
    group: "state",
    description:
      "Check whether a named protocol feature is supported on the connected server/version (via minecraft-data feature flags).",
    inputSchema: {
      featureName: z.string().describe('Feature flag name, e.g. "dimensionIsAString"'),
    },
    annotations: { readOnlyHint: true, title: "Check feature support" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      let supported: boolean | null = null;
      try {
        supported = bot.supportFeature(args.featureName as any) ?? null;
      } catch {
        supported = null;
      }
      return { feature: args.featureName, supported };
    },
  });

  reg({
    name: "pathfinder_status",
    group: "state",
    description:
      "Report the pathfinder's current activity: isMoving, isMining, isBuilding, and whether a goal is set.",
    inputSchema: {},
    annotations: { readOnlyHint: true, title: "Pathfinder status" },
    handler: (_args, ctx) => {
      const bot = ctx.manager.requireBot();
      const pf = (bot as any).pathfinder;
      const safe = (fn: () => unknown): boolean | null => {
        try {
          const v = fn();
          return typeof v === "boolean" ? v : null;
        } catch {
          return null;
        }
      };
      return {
        isMoving: safe(() => pf?.isMoving?.()),
        isMining: safe(() => pf?.isMining?.()),
        isBuilding: safe(() => pf?.isBuilding?.()),
        goal: !!(pf && pf.goal),
      };
    },
  });

  reg({
    name: "get_settings",
    group: "state",
    description: "Return the bot's current game settings (view distance, chat flags, skin parts, etc.).",
    inputSchema: {},
    annotations: { readOnlyHint: true, title: "Get settings" },
    handler: (_args, ctx) => {
      const bot = ctx.manager.requireBot();
      return bot.settings;
    },
  });

  reg({
    name: "get_physics",
    group: "state",
    description:
      "Return whether physics is enabled plus the physics constants (gravity, speeds, etc.) as primitive fields.",
    inputSchema: {},
    annotations: { readOnlyHint: true, title: "Get physics" },
    handler: (_args, ctx) => {
      const bot = ctx.manager.requireBot();
      const physics: Record<string, unknown> = {};
      const src = bot.physics as unknown as Record<string, unknown>;
      if (src) {
        for (const [k, v] of Object.entries(src)) {
          const t = typeof v;
          if (t === "number" || t === "boolean" || t === "string") physics[k] = v;
        }
      }
      return { physicsEnabled: bot.physicsEnabled, physics };
    },
  });

  reg({
    name: "get_loaded_plugins",
    group: "state",
    description: "Report which mineflayer ecosystem plugins are attached to the bot.",
    inputSchema: {},
    annotations: { readOnlyHint: true, title: "Get loaded plugins" },
    handler: (_args, ctx) => {
      const bot = ctx.manager.requireBot();
      return loadedPlugins(bot);
    },
  });
}

function serializeScoreboard(board: any): Record<string, unknown> {
  const items = Array.isArray(board?.items) ? board.items : [];
  return {
    name: board?.name ?? null,
    title: chatToString(board?.title),
    items: items.map((it: any) => ({ name: it?.name ?? null, value: it?.value ?? null })),
  };
}
