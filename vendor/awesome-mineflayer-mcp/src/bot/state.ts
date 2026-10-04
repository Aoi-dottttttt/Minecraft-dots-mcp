/** Snapshot builders shared by read-only tools and MCP resources. */

import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { round } from "../util/format.js";
import {
  serializeBlock,
  serializeEntity,
  serializeItem,
  serializeVec3,
  type EntityJson,
} from "../util/serialize.js";

const CONTROLS = ["forward", "back", "left", "right", "jump", "sprint", "sneak"] as const;

function chatToString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  const maybe = v as { toString?: () => string };
  try {
    return typeof maybe.toString === "function" ? maybe.toString() : String(v);
  } catch {
    return null;
  }
}

export function selfState(bot: Bot, detailed = false): Record<string, unknown> {
  const b = bot as any;
  const e = bot.entity;
  const controlState: Record<string, boolean> = {};
  for (const c of CONTROLS) {
    try {
      controlState[c] = bot.getControlState(c);
    } catch {
      controlState[c] = false;
    }
  }
  return {
    username: bot.username,
    position: serializeVec3(e?.position),
    velocity: serializeVec3(e?.velocity, 3),
    yaw: e?.yaw !== undefined ? round(e.yaw, 3) : null,
    pitch: e?.pitch !== undefined ? round(e.pitch, 3) : null,
    onGround: e?.onGround ?? null,
    health: bot.health ?? null,
    food: bot.food ?? null,
    saturation: bot.foodSaturation ?? null,
    oxygen: b.oxygenLevel ?? null,
    experience: bot.experience
      ? { level: bot.experience.level, points: bot.experience.points, progress: round(bot.experience.progress, 3) }
      : null,
    gameMode: bot.game?.gameMode ?? null,
    dimension: bot.game?.dimension ?? null,
    difficulty: bot.game?.difficulty ?? null,
    heldItem: serializeItem(bot.heldItem ?? null, detailed),
    quickBarSlot: bot.quickBarSlot ?? null,
    isSleeping: bot.isSleeping ?? false,
    isRaining: bot.isRaining ?? false,
    thunderState: b.thunderState ?? 0,
    time: bot.time
      ? { timeOfDay: bot.time.timeOfDay, day: bot.time.day, age: bot.time.age, isDay: bot.time.isDay }
      : null,
    spawnPoint: serializeVec3(bot.spawnPoint, 0),
    vehicle: b.vehicle ? serializeEntity(b.vehicle as Entity, { detailed: false }) : null,
    usingHeldItem: b.usingHeldItem ?? false,
    isDigging: bot.targetDigBlock ? serializeBlock(bot.targetDigBlock, false) : null,
    controlState,
    effects: e ? (e as any).effects ?? null : null,
    physicsEnabled: bot.physicsEnabled ?? true,
  };
}

const ARMOR_SLOTS: Record<string, number> = { head: 5, torso: 6, legs: 7, feet: 8 };
const OFFHAND_SLOT = 45;

export function inventoryState(bot: Bot, detailed = false): Record<string, unknown> {
  const inv = bot.inventory;
  const armor: Record<string, unknown> = {};
  for (const [name, slot] of Object.entries(ARMOR_SLOTS)) {
    armor[name] = serializeItem(inv.slots[slot] ?? null, detailed);
  }
  armor["offHand"] = serializeItem(inv.slots[OFFHAND_SLOT] ?? null, detailed);
  return {
    heldSlot: bot.quickBarSlot ?? null,
    heldItem: serializeItem(bot.heldItem ?? null, detailed),
    items: inv.items().map((i) => serializeItem(i, detailed)),
    armor,
    emptySlots: inv.emptySlotCount(),
    totalSlots: inv.slots.length,
  };
}

export function playersState(bot: Bot): Array<Record<string, unknown>> {
  return Object.values(bot.players).map((p) => ({
    username: p.username,
    displayName: chatToString(p.displayName),
    gamemode: p.gamemode ?? null,
    ping: p.ping ?? null,
    entityId: p.entity?.id ?? null,
    position: p.entity ? serializeVec3(p.entity.position) : null,
  }));
}

export interface EntityFilter {
  type?: string;
  kind?: string;
  mobType?: string;
  username?: string;
  name?: string;
  maxDistance?: number;
}

/** Filter + distance-sort tracked entities (excludes the bot itself). */
export function filterEntities(bot: Bot, f: EntityFilter = {}): Entity[] {
  const origin = bot.entity?.position;
  const selfId = bot.entity?.id;
  let list = (Object.values(bot.entities) as Entity[]).filter((e) => e && e.id !== selfId);

  if (f.type) list = list.filter((e) => (e as any).type === f.type);
  if (f.kind) list = list.filter((e) => ((e as any).kind ?? "").toLowerCase() === f.kind!.toLowerCase());
  if (f.mobType)
    list = list.filter((e) => ((e as any).mobType ?? e.name ?? "").toLowerCase() === f.mobType!.toLowerCase());
  if (f.username) list = list.filter((e) => (e as any).username === f.username);
  if (f.name) list = list.filter((e) => (e.name ?? "").toLowerCase() === f.name!.toLowerCase());
  if (f.maxDistance !== undefined && origin)
    list = list.filter((e) => e.position && e.position.distanceTo(origin) <= f.maxDistance!);

  if (origin) {
    list.sort((a, b) => a.position.distanceTo(origin) - b.position.distanceTo(origin));
  }
  return list;
}

export function entitiesState(bot: Bot, f: EntityFilter = {}, limit = 50, detailed = false): EntityJson[] {
  const origin = bot.entity?.position;
  return filterEntities(bot, f)
    .slice(0, limit)
    .map((e) => serializeEntity(e, { detailed, origin }));
}
