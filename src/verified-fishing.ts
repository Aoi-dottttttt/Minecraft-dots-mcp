// Bite detection adapted from Mineflayer 4.39.0 lib/plugins/fishing.js.
// Source: https://github.com/PrismarineJS/mineflayer/blob/4.39.0/lib/plugins/fishing.js
// Copyright (c) 2015 Andrew Kelley. MIT License:
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// Local additions: owner validation, finite deadline, abort/death cleanup and
// honest distinction between bite/reel evidence and an actual caught item.
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { getInventoryAuthority } from './inventory-authority.js';
import { equipVerified } from './verified-inventory.js';

export type FishingOptions = { signal?: AbortSignal; timeoutMs?: number };
export type FishingResult = {
  attempted: boolean; requestIssued: boolean; confirmed: false;
  castConfirmed: boolean; biteObserved: boolean; reelIssued: boolean;
  hookRemovalConfirmed: boolean; caughtItemConfirmed: false;
  timedOut: boolean; cancelled: boolean; evidence: string[]; detail: string;
  cleanup: { releaseIssued: boolean; retractionIssued: boolean; note?: string };
  bobberId?: number;
};
type SpawnPacket = { entityId: number; type: number; objectData?: number; ownerId?: number; ownerEntityId?: number; x: number; y: number; z: number };
type ParticlePacket = { particle?: { type?: string }; particleId?: number; amount?: number; particles?: number; x: number; y?: number; z: number };
const fishing = new WeakSet<Bot>();

/** One finite cast. No native bot.fish() promise is created or left behind. */
export async function fishOnceVerified(bot: Bot, options: FishingOptions = {}): Promise<FishingResult> {
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Fishing timeoutMs must be between 1 and 60000');
  options.signal?.throwIfAborted();
  if (fishing.has(bot)) throw new Error('A verified fishing action is already running');
  const authority = getInventoryAuthority(bot);
  authority.assertMutationReady();
  if (bot.currentWindow || authority.cursor) throw new Error('Close containers and clear the cursor before fishing');
  const slot = 36 + bot.quickBarSlot;
  if (authority.getFrame(0).slots[slot]?.name !== 'fishing_rod') throw new Error('Select a fishing_rod in the main hand before fishing');
  fishing.add(bot);
  try {
    await equipVerified(bot, slot, 'hand', Math.min(5000, timeoutMs), { exactSource: true });
    options.signal?.throwIfAborted();
    const bobberType = bot.supportFeature('fishingBobberCorrectlyNamed') ? bot.registry.entitiesByName.fishing_bobber?.id : 90;
    if (!Number.isInteger(bobberType)) throw new Error('Fishing-bobber type is unavailable in this protocol registry');
    const evidence = new Set<string>();
    let bobber: { id: number; position: Vec3; alive: boolean } | undefined;
    let attempted = false;
    let biteObserved = false;
    let reelIssued = false;
    let hookRemovalConfirmed = false;
    let sessionEnded = false;
    let finished = false;
    let resolveResult: (value: FishingResult) => void;
    const pending = new Promise<FishingResult>(resolve => { resolveResult = resolve; });
    const heldRod = () => {
      try {
        return !authority.ended && bot.quickBarSlot === slot - 36 && authority.getFrame(0).slots[slot]?.name === 'fishing_rod';
      } catch { return false; }
    };
    const cleanups: Array<() => void> = [];
    const cleanup = (retract: boolean): FishingResult['cleanup'] => {
      const state: FishingResult['cleanup'] = { releaseIssued: false, retractionIssued: false };
      // Do not toggle use when a hook was never server-confirmed: that could cast
      // a fresh line while cancelling. Do not reel an unknown or someone else's hook.
      if (retract && bobber?.alive && !reelIssued && !sessionEnded && heldRod()) {
        try { bot.activateItem(false); state.retractionIssued = true; reelIssued = true; }
        catch (error) { state.note = `Hook retraction could not be issued: ${String(error)}`; }
      } else if (retract && bobber?.alive && !reelIssued) {
        state.note = sessionEnded ? 'Session ended; hook retraction was not attempted' : 'Rod is no longer held; hook retraction was not attempted';
      }
      if (!sessionEnded) {
        try { bot.deactivateItem(); state.releaseIssued = true; }
        catch (error) { state.note = `${state.note ?? ''} Release could not be issued: ${String(error)}`.trim(); }
      }
      return state;
    };
    const finish = (reason: 'bite' | 'timeout' | 'cancelled' | 'ended' | 'removed' | 'failed', error?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanups.forEach(remove => remove());
      const cleanupResult = cleanup(reason !== 'bite');
      const detail = reason === 'bite'
        ? 'Owned bobber showed Mineflayer bite particles and a reel request was sent. No caught item is confirmed'
        : reason === 'timeout' ? 'Fishing deadline reached. No caught item is confirmed'
          : reason === 'cancelled' ? 'Fishing cancelled. No caught item is confirmed'
            : reason === 'removed' ? 'Owned bobber disappeared before a confirmed catch. No caught item is confirmed'
              : reason === 'ended' ? 'Session ended or player died during fishing'
                : `Fishing request failed: ${error instanceof Error ? error.message : String(error)}`;
      resolveResult!({ attempted, requestIssued: attempted, confirmed: false, castConfirmed: Boolean(bobber), biteObserved,
        reelIssued, hookRemovalConfirmed, caughtItemConfirmed: false, timedOut: reason === 'timeout', cancelled: reason === 'cancelled',
        evidence: [...evidence], detail, cleanup: cleanupResult, ...(bobber ? { bobberId: bobber.id } : {}) });
    };
    const spawn = (packet: SpawnPacket) => {
      if (finished || packet.type !== bobberType || bobber || !attempted) return;
      // In Java spawn_entity objectData for a fishing bobber is its owner entity
      // ID (not the hooked-entity metadata value, which has different semantics).
      const owner = packet.objectData ?? packet.ownerEntityId ?? packet.ownerId;
      if (!Number.isInteger(owner) || owner !== bot.entity.id) return;
      if (![packet.x, packet.y, packet.z].every(Number.isFinite)) return;
      const position = bot.entities[packet.entityId]?.position ?? new Vec3(packet.x, packet.y, packet.z);
      bobber = { id: packet.entityId, position, alive: true };
      evidence.add('server spawned a fishing bobber owned by this bot');
    };
    const particles = (packet: ParticlePacket) => {
      if (finished || !bobber?.alive || reelIssued || ![packet.x, packet.z].every(Number.isFinite)) return;
      const position = bot.entities[bobber.id]?.position ?? bobber.position;
      const modern = bot.registry.supportFeature('updatedParticlesPacket');
      // Preserve the installed Mineflayer bite algorithm, scoped to our owned hook.
      const pattern = modern
        ? (packet.particle?.type === 'fishing' || packet.particle?.type === 'bubble') && packet.amount === 6
        : packet.particleId === (bot.registry.particlesByName.fishing ?? bot.registry.particlesByName.bubble)?.id && packet.particles === 6;
      if (!pattern || position.distanceTo(new Vec3(packet.x, position.y, packet.z)) > 1.23) return;
      // The particle packet has no source entity. If another bobber is close
      // enough to explain these particles, ownership of the bite is ambiguous.
      const otherHookNear = Object.values(bot.entities).some(entity => entity.id !== bobber!.id &&
        (entity.name === 'fishing_bobber' || entity.entityType === bobberType) &&
        entity.position.distanceTo(new Vec3(packet.x, entity.position.y, packet.z)) <= 1.23);
      if (otherHookNear) return;
      if (!heldRod()) return finish('failed', new Error('Fishing rod changed before reeling'));
      biteObserved = true;
      evidence.add('Mineflayer bite-particle pattern near the owned bobber, with no nearby competing hook');
      try {
        reelIssued = true; // Set before call: a synchronous destroy event belongs to this reel.
        bot.activateItem(false);
        finish('bite');
      } catch (error) { finish('failed', error); }
    };
    const destroyed = (packet: { entityIds: number[] }) => {
      if (!bobber || !packet.entityIds.includes(bobber.id)) return;
      bobber.alive = false;
      hookRemovalConfirmed = true;
      evidence.add('server removed the owned bobber');
      if (!reelIssued) finish('removed');
    };
    const cancel = () => finish('cancelled');
    const end = () => { sessionEnded = true; finish('ended'); };
    bot._client.on('spawn_entity', spawn); cleanups.push(() => bot._client.removeListener('spawn_entity', spawn));
    bot._client.on('world_particles', particles); cleanups.push(() => bot._client.removeListener('world_particles', particles));
    bot._client.on('entity_destroy', destroyed); cleanups.push(() => bot._client.removeListener('entity_destroy', destroyed));
    bot.on('end', end); cleanups.push(() => bot.removeListener('end', end));
    bot.on('death', end); cleanups.push(() => bot.removeListener('death', end));
    options.signal?.addEventListener('abort', cancel, { once: true }); cleanups.push(() => options.signal?.removeEventListener('abort', cancel));
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    try {
      options.signal?.throwIfAborted();
      authority.assertMutationReady();
      attempted = true;
      bot.activateItem(false);
    } catch (error) { finish(options.signal?.aborted ? 'cancelled' : 'failed', error); }
    return await pending;
  } finally { fishing.delete(bot); }
}
