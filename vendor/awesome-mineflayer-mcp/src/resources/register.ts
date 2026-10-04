/**
 * MCP resources + push notifications (the "push" half of event delivery).
 *
 * Resources expose live bot state for subscribe-capable clients. On relevant
 * buffered events we (a) emit a throttled `notifications/resources/updated` for
 * subscribed resource URIs and (b) forward notable lines via `sendLoggingMessage`.
 * Everything here is best-effort and fully guarded — it must never crash the
 * server or interfere with the reliable polling tools (get_events/get_state).
 */

import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Vec3 } from "vec3";
import type { ToolContext } from "../context.js";
import { PUSH_THROTTLE_MS } from "../config.js";
import { selfState, inventoryState, playersState, entitiesState } from "../bot/state.js";
import { serializeBlock, serializeEntity } from "../util/serialize.js";
import { loadWaypoints } from "../waypoints.js";
import type { GameEvent } from "../bot/events.js";

interface ResourceDef {
  uri: string;
  name: string;
  title: string;
  description: string;
  build: (ctx: ToolContext) => unknown;
}

const RESOURCES: ResourceDef[] = [
  {
    uri: "bot://state",
    name: "bot-state",
    title: "Bot state",
    description: "Live self snapshot: position, vitals, gamemode, time, weather, held item, control states.",
    build: (ctx) => {
      const bot = ctx.manager.botOrNull();
      return bot ? selfState(bot, true) : { status: ctx.manager.status, note: "no bot connected" };
    },
  },
  {
    uri: "bot://inventory",
    name: "bot-inventory",
    title: "Bot inventory",
    description: "Live inventory: items, armor, off-hand, held slot, empty slots.",
    build: (ctx) => {
      const bot = ctx.manager.botOrNull();
      return bot ? inventoryState(bot, false) : { note: "no bot connected" };
    },
  },
  {
    uri: "world://entities",
    name: "world-entities",
    title: "Nearby entities",
    description: "Up to 50 nearest tracked entities (players, mobs, items).",
    build: (ctx) => {
      const bot = ctx.manager.botOrNull();
      return bot ? entitiesState(bot, {}, 50, false) : { note: "no bot connected" };
    },
  },
  {
    uri: "world://players",
    name: "world-players",
    title: "Players",
    description: "All players on the server with ping, gamemode and position.",
    build: (ctx) => {
      const bot = ctx.manager.botOrNull();
      return bot ? playersState(bot) : { note: "no bot connected" };
    },
  },
  {
    uri: "bot://events",
    name: "bot-events",
    title: "Recent events",
    description: "Tail of the most recent buffered game events.",
    build: (ctx) => ctx.events.recent(50),
  },
  {
    uri: "bot://waypoints",
    name: "bot-waypoints",
    title: "Waypoints",
    description: "Saved named waypoints (persisted across restarts).",
    build: () => Object.values(loadWaypoints()),
  },
];

/** Which resource URIs a given event type should mark as updated. */
function affectedResources(type: string): string[] {
  switch (type) {
    case "spawn":
    case "respawn":
    case "health":
    case "breath":
    case "experience":
    case "forcedMove":
    case "heldItemChanged":
    case "status":
    case "mount":
    case "dismount":
    case "sleep":
    case "wake":
    case "death":
      return ["bot://state"];
    case "playerCollect":
    case "windowClose":
      return ["bot://inventory", "bot://state"];
    case "entitySpawn":
    case "entityGone":
      return ["world://entities"];
    case "playerJoined":
    case "playerLeft":
      return ["world://players"];
    default:
      return [];
  }
}

/** Buffered event types worth surfacing as MCP log notifications. */
const LOG_LEVEL_BY_TYPE: Record<string, "info" | "warning" | "error"> = {
  chat: "info",
  whisper: "info",
  message: "info",
  death: "warning",
  kicked: "warning",
  end: "warning",
  error: "error",
  msa_code: "info",
  reconnecting: "warning",
  reconnected: "info",
  reconnect_failed: "error",
};

export function registerResources(ctx: ToolContext): void {
  const { server, events } = ctx;

  for (const def of RESOURCES) {
    try {
      server.registerResource(
        def.name,
        def.uri,
        { title: def.title, description: def.description, mimeType: "application/json" },
        (uri: URL) => ({
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(def.build(ctx), null, 2),
            },
          ],
        }),
      );
    } catch (e) {
      process.stderr.write(`[mineflayer-mcp] failed to register resource ${def.uri}: ${String(e)}\n`);
    }
  }

  // --- Parameterized resource templates (@-mentionable, on-demand lookups) ---
  const jsonContents = (uri: URL, value: unknown) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value, null, 2) }],
  });
  try {
    server.registerResource(
      "block",
      new ResourceTemplate("block://{x}/{y}/{z}", { list: undefined }),
      { title: "Block at position", description: "Block at world coordinate x/y/z (e.g. block://10/64/-20).", mimeType: "application/json" },
      (uri: URL, vars: Record<string, string | string[]>) => {
        const bot = ctx.manager.botOrNull();
        const n = (v: string | string[]): number => Number(Array.isArray(v) ? v[0] : v);
        if (!bot) return jsonContents(uri, { note: "no bot connected" });
        const block = bot.blockAt(new Vec3(n(vars.x!), n(vars.y!), n(vars.z!)));
        return jsonContents(uri, serializeBlock(block, true) ?? { note: "no block (unloaded chunk?)" });
      },
    );
    server.registerResource(
      "entity",
      new ResourceTemplate("entity://{id}", { list: undefined }),
      { title: "Entity by id", description: "Tracked entity by network id (e.g. entity://123).", mimeType: "application/json" },
      (uri: URL, vars: Record<string, string | string[]>) => {
        const bot = ctx.manager.botOrNull();
        if (!bot) return jsonContents(uri, { note: "no bot connected" });
        const id = Number(Array.isArray(vars.id) ? vars.id[0] : vars.id);
        const e = bot.entities[id];
        return jsonContents(uri, e ? serializeEntity(e, { detailed: true, origin: bot.entity?.position }) : { note: `no entity ${id}` });
      },
    );
  } catch (e) {
    process.stderr.write(`[mineflayer-mcp] failed to register resource templates: ${String(e)}\n`);
  }

  // --- Throttled push of resource-updated notifications ---
  const pendingUris = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    flushTimer = null;
    for (const uri of pendingUris) {
      try {
        const low = (server as unknown as { server?: { notification?: (n: unknown) => Promise<unknown> | void } }).server;
        const p = low?.notification?.({ method: "notifications/resources/updated", params: { uri } });
        if (p && typeof (p as Promise<unknown>).catch === "function") (p as Promise<unknown>).catch(() => {});
      } catch {
        /* notification is best-effort */
      }
    }
    pendingUris.clear();
  };

  const markUpdated = (uris: string[]): void => {
    for (const u of uris) pendingUris.add(u);
    pendingUris.add("bot://events");
    if (!flushTimer) flushTimer = setTimeout(flush, PUSH_THROTTLE_MS);
  };

  const forwardLog = (e: GameEvent): void => {
    const level = LOG_LEVEL_BY_TYPE[e.type];
    if (!level) return;
    try {
      void server
        .sendLoggingMessage({ level, logger: "mineflayer", data: { type: e.type, ...(e.data as object) } })
        .catch(() => {});
    } catch {
      /* logging is best-effort (client may not support it) */
    }
  };

  events.onPush((e) => {
    markUpdated(affectedResources(e.type));
    forwardLog(e);
  });
}
