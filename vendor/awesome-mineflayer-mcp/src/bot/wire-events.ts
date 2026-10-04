/**
 * Maps mineflayer (and plugin) events into the EventBus.
 *
 * Only discrete, agent-actionable events are buffered. High-frequency
 * observations (move, entityMoved, blockUpdate, time, physicsTick, particle,
 * scoreboard/team updates) are intentionally NOT buffered — they are re-read on
 * demand via get_state / read tools / resources. Proximity-filtered events are
 * dropped when far from the bot to keep the buffer signal-dense.
 */

import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { EventBus } from "./events.js";
import { PROXIMITY_RADIUS } from "../config.js";
import { serializeVec3 } from "../util/serialize.js";

type Vec3Like = { x: number; y: number; z: number };

export function wireBotEvents(bot: Bot, events: EventBus): () => void {
  const offs: Array<() => void> = [];
  const b = bot as any;

  const on = (name: string, handler: (...args: any[]) => void): void => {
    const safe = (...args: any[]): void => {
      try {
        handler(...args);
      } catch {
        // Event capture must never throw back into mineflayer's emitter.
      }
    };
    bot.on(name as any, safe);
    offs.push(() => bot.removeListener(name as any, safe));
  };

  const near = (pos: Vec3Like | null | undefined): boolean => {
    const p = bot.entity?.position;
    if (!p || !pos) return true;
    const dx = p.x - pos.x;
    const dy = p.y - pos.y;
    const dz = p.z - pos.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) <= PROXIMITY_RADIUS;
  };

  const ent = (e: Entity | undefined | null): Record<string, unknown> | null =>
    e ? { id: e.id, type: (e as any).type, name: e.name ?? null, username: (e as any).username ?? null, position: serializeVec3(e.position) } : null;

  // --- Chat / messages ---
  on("chat", (username: string, message: string) => events.push("chat", { username, message }));
  on("whisper", (username: string, message: string) => events.push("whisper", { username, message }));
  on("messagestr", (message: string, position?: string) => {
    if (position === "chat") return; // already captured as a structured chat event
    events.push("message", { text: message, position: position ?? null });
  });
  on("actionBar", (msg: unknown) => events.push("actionBar", { text: String(msg ?? "") }));
  on("title", (title: unknown, type?: unknown) => events.push("title", { text: String(title ?? ""), type: type ?? null }));
  on("resourcePack", (url: string) => events.push("resourcePack", { url }));

  // --- Lifecycle / vitals (end + kicked handled by BotManager for reconnect) ---
  on("login", () => events.push("login", { username: bot.username }));
  on("spawn", () => events.push("spawn", { position: serializeVec3(bot.entity?.position) }));
  on("respawn", () => events.push("respawn", { dimension: bot.game?.dimension ?? null }));
  on("spawnReset", () => events.push("spawnReset", null));
  on("death", () => events.push("death", { position: serializeVec3(bot.entity?.position) }));
  on("health", () => events.push("health", { health: bot.health, food: bot.food, saturation: bot.foodSaturation }));
  on("breath", () => events.push("breath", { oxygen: b.oxygenLevel ?? null }));
  on("forcedMove", () => events.push("forcedMove", { position: serializeVec3(bot.entity?.position) }));
  on("error", (err: Error) => events.push("error", { message: err?.message ?? String(err) }));

  let lastLevel = -1;
  on("experience", () => {
    const level = bot.experience?.level ?? 0;
    if (level !== lastLevel) {
      lastLevel = level;
      events.push("experience", { level, points: bot.experience?.points ?? 0 });
    }
  });

  let lastHeldName: string | null = null;
  on("heldItemChanged", () => {
    const name = bot.heldItem?.name ?? null;
    if (name !== lastHeldName) {
      lastHeldName = name;
      events.push("heldItemChanged", { name });
    }
  });

  // --- Weather ---
  on("rain", () => events.push("rain", { isRaining: bot.isRaining }));
  on("weatherUpdate", () => events.push("weatherUpdate", { isRaining: bot.isRaining, thunderState: b.thunderState ?? 0 }));

  // --- Players ---
  on("playerJoined", (p: { username: string }) => events.push("playerJoined", { username: p?.username }));
  on("playerLeft", (p: { username: string }) => events.push("playerLeft", { username: p?.username }));
  on("playerCollect", (collector: Entity, collected: Entity) =>
    events.push("playerCollect", {
      collector: collector?.id ?? null,
      collected: collected?.id ?? null,
      byBot: collector?.id === bot.entity?.id,
    }),
  );

  // --- Entities (proximity-filtered) ---
  on("entitySpawn", (e: Entity) => { if (near(e?.position)) events.push("entitySpawn", ent(e)); });
  on("itemDrop", (e: Entity) => { if (near(e?.position)) events.push("itemDrop", ent(e)); });
  on("entityGone", (e: Entity) => events.push("entityGone", { id: e?.id }));
  on("entityHurt", (e: Entity) => { if (near(e?.position)) events.push("entityHurt", { id: e?.id, name: e?.name ?? null }); });
  on("entityDead", (e: Entity) => { if (near(e?.position)) events.push("entityDead", { id: e?.id, name: e?.name ?? null }); });
  on("entityEffect", (e: Entity, effect: unknown) => {
    if (e?.id === bot.entity?.id || near(e?.position)) events.push("entityEffect", { id: e?.id, effect });
  });

  // Reactive entity cluster (proximity-filtered, minimal payload).
  for (const evt of [
    "entityEquip",
    "entitySwingArm",
    "entitySleep",
    "entityWake",
    "entityCrouch",
    "entityUncrouch",
    "entityHandSwap",
    "entityElytraFlew",
    "entityTaming",
    "entityTamed",
  ]) {
    on(evt, (e: Entity) => { if (near(e?.position)) events.push(evt, { id: e?.id, name: e?.name ?? null }); });
  }
  on("entityAttach", (e: Entity, vehicle: Entity) => events.push("entityAttach", { id: e?.id, vehicle: vehicle?.id ?? null }));
  on("entityDetach", (e: Entity, vehicle: Entity) => events.push("entityDetach", { id: e?.id, vehicle: vehicle?.id ?? null }));

  // --- Digging / building ---
  on("diggingCompleted", (block: { position?: Vec3Like; name?: string }) =>
    events.push("diggingCompleted", { position: serializeVec3(block?.position as any), name: block?.name ?? null }),
  );
  on("diggingAborted", (block: { position?: Vec3Like; name?: string }) =>
    events.push("diggingAborted", { position: serializeVec3(block?.position as any), name: block?.name ?? null }),
  );
  on("blockPlaced", (_old: unknown, newBlock: { position?: Vec3Like; name?: string }) =>
    events.push("blockPlaced", { position: serializeVec3(newBlock?.position as any), name: newBlock?.name ?? null }),
  );

  // --- Windows / sleep / vehicles ---
  on("windowOpen", (w: { id?: number; type?: unknown }) => events.push("windowOpen", { id: w?.id ?? null, type: w?.type ?? null }));
  on("windowClose", () => events.push("windowClose", null));
  on("sleep", () => events.push("sleep", null));
  on("wake", () => events.push("wake", null));
  on("mount", () => events.push("mount", { vehicle: b.vehicle?.id ?? null }));
  on("dismount", () => events.push("dismount", null));

  // --- Sounds / world feedback (proximity-filtered) ---
  on("soundEffectHeard", (soundName: string, position: { x: number; y: number; z: number }) => {
    if (near(position)) events.push("soundEffectHeard", { soundName, position: serializeVec3(position as any) });
  });
  on("usedFirework", () => events.push("usedFirework", null));
  on("bossBarCreated", () => events.push("bossBarCreated", null));
  on("bossBarDeleted", () => events.push("bossBarDeleted", null));

  // --- Pathfinder plugin ---
  on("goal_reached", () => events.push("goal_reached", null));
  on("path_reset", (reason: unknown) => events.push("path_reset", { reason: String(reason ?? "") }));
  on("goal_updated", () => events.push("goal_updated", null));

  // --- PvP plugin ---
  on("stoppedAttacking", () => events.push("pvp_stopped", null));

  // --- Auto-eat plugin (EventEmitter on bot.autoEat) ---
  if (b.autoEat && typeof b.autoEat.on === "function") {
    const ae = b.autoEat;
    const aeStart = (): void => void events.push("autoeat_start", null);
    const aeFinish = (): void => void events.push("autoeat_finish", null);
    const aeFail = (err: Error): void => void events.push("autoeat_fail", { message: err?.message ?? String(err) });
    ae.on("eatStart", aeStart);
    ae.on("eatFinish", aeFinish);
    ae.on("eatFail", aeFail);
    offs.push(() => {
      ae.removeListener("eatStart", aeStart);
      ae.removeListener("eatFinish", aeFinish);
      ae.removeListener("eatFail", aeFail);
    });
  }

  return () => {
    for (const off of offs) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
  };
}
