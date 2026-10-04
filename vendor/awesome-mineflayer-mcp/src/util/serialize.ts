/**
 * Convert prismarine game objects into compact, agent-friendly JSON.
 *
 * Defaults are concise (names over ids, rounded coords, only the fields an agent
 * usually needs). `detailed` adds the heavier fields (metadata, effects, nbt).
 */

import type { Block } from "prismarine-block";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import type { Vec3 } from "vec3";
import { round } from "./format.js";

export interface Vec3Json {
  x: number;
  y: number;
  z: number;
}

export function serializeVec3(v: Vec3 | { x: number; y: number; z: number } | null | undefined, dp = 2): Vec3Json | null {
  if (!v) return null;
  return { x: round(v.x, dp), y: round(v.y, dp), z: round(v.z, dp) };
}

export interface ItemJson {
  name: string;
  displayName?: string;
  count: number;
  slot?: number;
  metadata?: number;
  durabilityLeft?: number | null;
  enchants?: Array<{ name: string; lvl: number }>;
  customName?: string | null;
  hasNbt?: boolean;
}

export function serializeItem(item: Item | null | undefined, detailed = false): ItemJson | null {
  if (!item) return null;
  const out: ItemJson = {
    name: item.name,
    displayName: item.displayName,
    count: item.count,
    slot: item.slot,
  };
  if (detailed) {
    out.metadata = item.metadata;
    // durabilityUsed / maxDurability may be undefined for non-tools.
    const maxDur = (item as unknown as { maxDurability?: number }).maxDurability;
    const used = (item as unknown as { durabilityUsed?: number }).durabilityUsed;
    out.durabilityLeft = typeof maxDur === "number" ? maxDur - (used ?? 0) : null;
    try {
      const enchants = (item as unknown as { enchants?: Array<{ name: string; lvl: number }> }).enchants;
      if (Array.isArray(enchants) && enchants.length > 0) out.enchants = enchants;
    } catch {
      /* enchant parsing depends on nbt; ignore failures */
    }
    out.customName = (item as unknown as { customName?: string | null }).customName ?? null;
    out.hasNbt = item.nbt != null;
  }
  return out;
}

export interface BlockJson {
  name: string;
  displayName?: string;
  position: Vec3Json | null;
  type?: number;
  // detailed:
  hardness?: number | null;
  diggable?: boolean;
  boundingBox?: string;
  material?: string | null;
  signText?: string | string[] | null;
}

export function serializeBlock(block: Block | null | undefined, detailed = false): BlockJson | null {
  if (!block) return null;
  const out: BlockJson = {
    name: block.name,
    displayName: block.displayName,
    position: block.position ? serializeVec3(block.position, 0) : null,
  };
  if (detailed) {
    out.type = block.type;
    out.hardness = (block as unknown as { hardness?: number }).hardness ?? null;
    out.diggable = (block as unknown as { diggable?: boolean }).diggable;
    out.boundingBox = (block as unknown as { boundingBox?: string }).boundingBox;
    out.material = (block as unknown as { material?: string | null }).material ?? null;
  }
  const signText =
    (block as unknown as { signText?: string | string[] }).signText ??
    (typeof (block as unknown as { getSignText?: () => unknown }).getSignText === "function"
      ? (block as unknown as { getSignText: () => string | string[] }).getSignText()
      : undefined);
  if (signText !== undefined) out.signText = signText as string | string[];
  return out;
}

export interface EntityJson {
  id: number;
  type?: string;
  name?: string | null;
  displayName?: string | null;
  username?: string | null;
  kind?: string | null;
  position: Vec3Json | null;
  distance?: number;
  onGround?: boolean;
  // detailed:
  health?: number | null;
  yaw?: number;
  pitch?: number;
  velocity?: Vec3Json | null;
  heldItem?: ItemJson | null;
  equipment?: Array<ItemJson | null>;
  effects?: unknown;
  metadata?: unknown;
}

export function serializeEntity(
  entity: Entity,
  opts: { detailed?: boolean; origin?: Vec3 | { x: number; y: number; z: number } } = {},
): EntityJson {
  const { detailed = false, origin } = opts;
  const e = entity as unknown as {
    id: number;
    type?: string;
    name?: string;
    displayName?: string;
    username?: string;
    kind?: string;
    position: Vec3;
    velocity?: Vec3;
    yaw?: number;
    pitch?: number;
    onGround?: boolean;
    health?: number;
    heldItem?: Item;
    equipment?: Array<Item | null>;
    effects?: unknown;
    metadata?: unknown;
  };
  const out: EntityJson = {
    id: e.id,
    type: e.type,
    name: e.name ?? null,
    displayName: e.displayName ?? null,
    username: e.username ?? null,
    kind: e.kind ?? null,
    position: serializeVec3(e.position),
    onGround: e.onGround,
  };
  if (origin && e.position) {
    const dx = e.position.x - origin.x;
    const dy = e.position.y - origin.y;
    const dz = e.position.z - origin.z;
    out.distance = round(Math.sqrt(dx * dx + dy * dy + dz * dz), 2);
  }
  if (detailed) {
    out.health = e.health ?? null;
    out.yaw = e.yaw !== undefined ? round(e.yaw, 3) : undefined;
    out.pitch = e.pitch !== undefined ? round(e.pitch, 3) : undefined;
    out.velocity = serializeVec3(e.velocity, 3);
    out.heldItem = serializeItem(e.heldItem ?? null, true);
    if (Array.isArray(e.equipment)) {
      out.equipment = e.equipment.map((it) => serializeItem(it ?? null, true));
    }
    out.effects = e.effects ?? null;
    out.metadata = e.metadata ?? null;
  }
  return out;
}
