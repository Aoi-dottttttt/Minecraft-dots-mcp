import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import { getInventoryAuthority } from './inventory-authority.js';
import { mountVerified, selectInteractionItem, type InteractionOptions, type ItemSelection, type Point } from './survival-interactions.js';

const air = new Set(['air', 'cave_air', 'void_air']);
const boatItems = new Set(['oak_boat', 'spruce_boat', 'birch_boat', 'jungle_boat', 'acacia_boat', 'dark_oak_boat', 'mangrove_boat', 'cherry_boat', 'bamboo_raft']);
type LaunchOptions = InteractionOptions & ItemSelection & { mount?: boolean };

function launchSite(bot: Bot, point: Point): Vec3 {
  if (![point.x, point.y, point.z].every(Number.isSafeInteger)) throw new Error('Boat target coordinates must be finite block integers');
  const position = new Vec3(point.x, point.y, point.z);
  const aim = position.offset(0.5, 0.9, 0.5);
  const eye = bot.entity.position.offset(0, (bot.entity as Entity & { eyeHeight?: number }).eyeHeight ?? 1.62, 0);
  if (eye.distanceTo(aim) > 4.5) throw new Error('Boat water target is outside survival use reach (4.5 blocks)');
  // The 1.375-wide boat extends into the adjacent cells even when centered.
  // A full 3x3 source-water patch and two air layers is deliberately conservative.
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const water = bot.blockAt(position.offset(dx, 0, dz), false);
    if (!water || water.name !== 'water' || Number(water.getProperties().level) !== 0) throw new Error('Boat launch needs a fully loaded 3x3 source-water patch');
    for (let dy = 1; dy <= 2; dy++) {
      const upper = bot.blockAt(position.offset(dx, dy, dz), false);
      if (!upper || !air.has(upper.name) || !Array.isArray(upper.shapes) || upper.shapes.length) throw new Error('Boat launch needs clear loaded headroom; no blocks will be removed');
    }
  }
  if (Object.values(bot.entities).some(entity => entity.id !== bot.entity.id && entity.position?.distanceTo(aim) < 2)) {
    throw new Error('Boat launch area is occupied by a tracked entity; choose a clear water patch');
  }
  const direction = aim.minus(eye).normalize();
  const distance = eye.distanceTo(aim);
  for (let d = 0; d <= distance; d += 0.1) {
    if (!bot.blockAt(eye.plus(direction.scaled(d)), false)) throw new Error('Boat line of sight passes through an unloaded chunk');
  }
  if (!bot.world?.raycast) throw new Error('World raycast is unavailable for boat placement');
  // Source-water ray targeting, unlike canSeeBlock alone, rejects an earlier
  // fluid hit that would place the boat somewhere other than the requested cell.
  const hit = bot.world.raycast(eye, direction, distance + 0.1, block => !air.has(block.name));
  if (!hit?.position.equals(position)) throw new Error('Boat target is not the first visible water hit; choose an unobstructed target');
  return aim;
}

/** One public Mineflayer activateItem call, not placeEntity's two-step helper.
 * Exact server inventory debit plus one newly spawned nearby boat gates mount.
 * No steering, dismounting, retry, recovery click or ownership inference is added. */
export async function launchBoatVerified(bot: Bot, point: Point, options: LaunchOptions = {}): Promise<{
  requestIssued: true; confirmed: boolean; placementConfirmed: true; mountConfirmed: boolean | null;
  entityId: number; evidence: string[]; detail: string; automaticRetry: false; liveValidated: false;
}> {
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new Error('Boat timeoutMs must be 1..10000');
  options.signal?.throwIfAborted();
  const authority = getInventoryAuthority(bot);
  authority.assertMutationReady();
  if (bot.game?.gameMode !== 'survival' && bot.game?.gameMode !== 'adventure') throw new Error('Boat launch requires ordinary survival/adventure inventory consumption');
  if ((bot as Bot & { vehicle?: Entity }).vehicle) throw new Error('Dismount the current vehicle before launching a boat');
  if (bot.getControlState('sneak')) throw new Error('Release sneak before boat launch');
  launchSite(bot, point);
  await selectInteractionItem(bot, options, false, options);
  let slot = 36 + bot.quickBarSlot;
  let item = authority.getFrame(0).slots[slot];
  if (!item || !boatItems.has(item.name)) throw new Error('Select an ordinary boat or bamboo raft; chest boats are not part of this workflow');
  await bot.lookAt(new Vec3(point.x + 0.5, point.y + 0.9, point.z + 0.5), true);
  options.signal?.throwIfAborted();
  authority.assertMutationReady();
  const aim = launchSite(bot, point);
  slot = 36 + bot.quickBarSlot;
  const frame = authority.getFrame(0);
  if (!authority.same(frame.slots[slot], item, true)) throw new Error('Selected boat changed during preparation; placement was not issued');
  item = frame.slots[slot]!;
  const before = { sequence: authority.sequence, slots: [...frame.slots] };
  const existing = new Set(Object.keys(bot.entities).map(Number));
  const candidates = new Set<number>();
  const dimension = bot.game.dimension;
  let issued = false;
  let cleanupError: unknown;
  let boatId: number;
  try {
    boatId = await new Promise<number>((resolve, reject) => {
      let settled = false;
      let inventoryFailure: Error | undefined;
      let sawDebit = false;
      const inventoryDebit = () => {
        options.signal?.throwIfAborted(); authority.assertMutationReady();
        if (bot.currentWindow || authority.cursor || bot.game.dimension !== dimension || slot !== 36 + bot.quickBarSlot) throw new Error('Boat inventory/session context changed after use');
        const current = authority.getFrame(0);
        if (current.slots.length !== before.slots.length || !before.slots.every((old, index) => index === slot || authority.same(old, current.slots[index], true))) {
          throw new Error('Unrelated inventory changed during boat placement');
        }
        const selected = current.slots[slot];
        const debit = current.revisions[slot] > before.sequence && (item.count === 1 ? selected === null
          : authority.same(item, selected, false) && selected?.count === item.count - 1);
        if (!debit && (sawDebit || !authority.same(item, selected, true))) throw new Error('Boat debit was reversed or did not match exactly one item');
        if (debit) sawDebit = true;
        return debit;
      };
      const finish = (id?: number, error?: Error) => {
        if (settled) return; settled = true;
        clearTimeout(timer);
        bot._client.removeListener('spawn_entity', spawned);
        authority.removeListener('change', changed);
        bot.removeListener('end', ended); bot.removeListener('death', ended);
        options.signal?.removeEventListener('abort', cancelled);
        if (error) reject(error); else resolve(id!);
      };
      const check = () => {
        if (settled || !issued) return;
        try {
          if (inventoryFailure) throw inventoryFailure;
          const debit = inventoryDebit();
          if (candidates.size > 1) throw new Error('Boat placement is ambiguous: more than one matching nearby boat spawned');
          const id = [...candidates][0];
          const entity = id === undefined ? undefined : bot.entities[id];
          if (debit && candidates.size === 1 && entity?.name === 'boat' && entity.position.distanceTo(aim) <= 1.25) finish(id);
        } catch (error) { finish(undefined, error instanceof Error ? error : new Error(String(error))); }
      };
      const changed = () => {
        if (!settled && issued && !inventoryFailure) {
          try { inventoryDebit(); } catch (error) { inventoryFailure = error instanceof Error ? error : new Error(String(error)); }
        }
        queueMicrotask(check);
      };
      const spawned = (packet: { entityId?: number; type?: number; x?: number; y?: number; z?: number }) => {
        if (!issued || !Number.isSafeInteger(packet.entityId) || existing.has(packet.entityId!) || packet.type !== bot.registry.entitiesByName.boat?.id ||
          ![packet.x, packet.y, packet.z].every(Number.isFinite)) return;
        if (new Vec3(packet.x!, packet.y!, packet.z!).distanceTo(aim) <= 1.25) candidates.add(packet.entityId!);
        changed();
      };
      const ended = () => finish(undefined, new Error('Session ended or player died during boat placement'));
      const cancelled = () => finish(undefined, new Error('Boat placement cancelled after item use'));
      const timer = setTimeout(() => finish(undefined, new Error('Boat placement not confirmed by exact inventory debit and one fresh nearby boat')), timeoutMs);
      bot._client.on('spawn_entity', spawned); authority.on('change', changed);
      bot.on('end', ended); bot.on('death', ended);
      options.signal?.addEventListener('abort', cancelled, { once: true });
      try {
        options.signal?.throwIfAborted();
        issued = true;
        bot.activateItem(false);
        changed();
      } catch (error) { finish(undefined, error instanceof Error ? error : new Error(String(error))); }
    });
  } catch (error) {
    if (issued) authority.block('Boat placement outcome was not confirmed; do not repeat automatically');
    throw error;
  } finally {
    if (issued) {
      try { bot.deactivateItem(); }
      catch (error) { authority.block('Boat item-use cleanup failed; do not repeat automatically'); cleanupError = error; }
    }
  }
  if (cleanupError) throw cleanupError;
  options.signal?.throwIfAborted();
  let mountConfirmed: boolean | null = null;
  const evidence = ['fresh raw server boat spawn within the inspected launch area', 'exact authoritative selected-slot debit with all other inventory conserved'];
  if (options.mount) {
    const mounted = await mountVerified(bot, boatId, { timeoutMs, signal: options.signal });
    mountConfirmed = mounted.confirmed;
    evidence.push(...mounted.evidence);
  }
  return {
    requestIssued: true, confirmed: options.mount ? mountConfirmed === true : true,
    placementConfirmed: true, mountConfirmed, entityId: boatId, evidence, automaticRetry: false, liveValidated: false,
    detail: options.mount ? (mountConfirmed ? 'Boat placement and server passenger attachment observed; driving and landing are not established.'
      : 'Boat placement observed, but mounting was not confirmed. Inspect the existing boat; no second placement or steering was attempted.')
      : 'Boat placement observed. Mount, steering and dismount remain separate deliberate actions.'
  };
}
