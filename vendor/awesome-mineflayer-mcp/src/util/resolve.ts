/**
 * Resolve human-friendly block/item/entity names to numeric ids using the
 * connected server's minecraft-data registry (`bot.registry`). On a miss,
 * throws an actionable UNKNOWN_NAME error carrying fuzzy suggestions.
 */

import { errors } from "./errors.js";

interface MdEntry {
  id: number;
  name: string;
  displayName?: string;
}

/** Structural view of the minecraft-data registry fields we use. */
export interface Registry {
  itemsByName: Record<string, MdEntry>;
  items: Record<number, MdEntry>;
  blocksByName: Record<string, MdEntry>;
  blocks: Record<number, MdEntry>;
  entitiesByName: Record<string, MdEntry>;
  entities: Record<number, MdEntry>;
  foodsByName?: Record<string, MdEntry>;
}

export interface ResolvedRef {
  id: number;
  name: string;
  displayName: string;
}

function norm(e: MdEntry): ResolvedRef {
  return { id: e.id, name: e.name, displayName: e.displayName ?? e.name };
}

/** Levenshtein distance (small inputs; iterative two-row). */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = new Array<number>(bl + 1);
  let curr = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bl]!;
}

/** Up to `max` closest names to `query` (exact, then substring, then near edit distance). */
export function fuzzySuggest(query: string, names: string[], max = 5): string[] {
  const q = query.toLowerCase();
  // Only treat names as "near" when their edit distance is small relative to the
  // query length, so unrelated names are not suggested.
  const maxDist = Math.max(2, Math.floor(q.length / 3));
  const scored: Array<{ name: string; score: number }> = [];
  for (const name of names) {
    const n = name.toLowerCase();
    if (n === q) {
      scored.push({ name, score: -1000 });
    } else if (n.includes(q) || q.includes(n)) {
      scored.push({ name, score: -100 + Math.abs(n.length - q.length) });
    } else {
      const d = editDistance(q, n);
      if (d <= maxDist) scored.push({ name, score: d });
    }
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, max).map((s) => s.name);
}

function resolveFrom(
  kind: string,
  byName: Record<string, MdEntry>,
  byId: Record<number, MdEntry>,
  ref: string | number,
): ResolvedRef {
  if (typeof ref === "number" || /^\d+$/.test(String(ref).trim())) {
    const id = Number(ref);
    const entry = byId[id];
    if (entry) return norm(entry);
    throw errors.unknownName(kind, String(ref), []);
  }
  const key = String(ref).trim().toLowerCase().replace(/^minecraft:/, "");
  const entry = byName[key];
  if (entry) return norm(entry);
  throw errors.unknownName(kind, String(ref), fuzzySuggest(key, Object.keys(byName)));
}

export function resolveItem(registry: Registry, ref: string | number): ResolvedRef {
  return resolveFrom("item", registry.itemsByName, registry.items, ref);
}

export function resolveBlock(registry: Registry, ref: string | number): ResolvedRef {
  return resolveFrom("block", registry.blocksByName, registry.blocks, ref);
}

export function resolveEntityType(registry: Registry, ref: string | number): ResolvedRef {
  return resolveFrom("entity", registry.entitiesByName, registry.entities, ref);
}

/** Resolve a list of names to numeric ids (for Movements block/entity lists). */
export function resolveBlockIds(registry: Registry, refs: Array<string | number>): number[] {
  return refs.map((r) => resolveBlock(registry, r).id);
}

export function resolveItemIds(registry: Registry, refs: Array<string | number>): number[] {
  return refs.map((r) => resolveItem(registry, r).id);
}
