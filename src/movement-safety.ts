import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { getInventoryAuthority } from './inventory-authority.js';
import { getOxygenAuthority, installOxygenAuthority, readOxygenEvidence, type OxygenEvidence } from './oxygen-authority.js';

// Reuse the locked pathfinder/physics implementations. This policy deliberately
// does not turn their liquid movement support into an autonomous swimming claim.
const aquaticBlocks = new Set(['water', 'lava', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
const air = new Set(['air', 'cave_air', 'void_air']);
const waterloggedExclusion = (block: Block): number => block.getProperties?.().waterlogged === true ? 100 : 0;
type SafeMovements = Bot['pathfinder']['movements'] & {
  canOpenDoors: boolean;
  infiniteLiquidDropdownDistance: boolean;
  dontMineUnderFallingBlock: boolean;
  dontCreateFlow: boolean;
  blocksToAvoid: Set<number>;
  exclusionAreasStep: Array<(block: Block) => number>;
};

/** Tighten, never replace, the caller's restrictions. Also covers plugin profiles. */
export function constrainMovements(bot: Bot, profile: Bot['pathfinder']['movements']): void {
  const movements = profile as SafeMovements;
  Object.assign(movements, {
    canDig: false, canOpenDoors: false, allow1by1towers: false,
    allowParkour: false, allowFreeMotion: false, scafoldingBlocks: [],
    infiniteLiquidDropdownDistance: false, dontMineUnderFallingBlock: true, dontCreateFlow: true,
    maxDropDown: Math.min(Number.isFinite(movements.maxDropDown) ? movements.maxDropDown : 2, 2)
  });
  movements.blocksToAvoid = new Set(movements.blocksToAvoid);
  for (const name of aquaticBlocks) {
    const id = bot.registry?.blocksByName[name]?.id;
    if (id !== undefined) movements.blocksToAvoid.add(id);
  }
  movements.exclusionAreasStep = [...(movements.exclusionAreasStep ?? [])];
  if (!movements.exclusionAreasStep.includes(waterloggedExclusion)) movements.exclusionAreasStep.push(waterloggedExclusion);
}

/** The temporary policy is restored only by its owner, after goto settles. */
export function useDryLandMovements(bot: Bot): () => void {
  const original = bot.pathfinder.movements;
  if (!original) return () => {};
  const movements = Object.assign(Object.create(Object.getPrototypeOf(original)), original) as typeof original;
  constrainMovements(bot, movements);
  const restore = () => { if (bot.pathfinder.movements === movements) bot.pathfinder.setMovements(original); };
  try { bot.pathfinder.setMovements(movements); }
  catch (error) { restore(); throw error; }
  return restore;
}

function wet(block: Block | null): boolean {
  return !!block && (aquaticBlocks.has(block.name) || block.getProperties?.().waterlogged === true);
}

/** Stops a dry route on unexpected water/low air; it never resumes or retries it. */
export function navigationHazard(bot: Bot): string | null {
  if (Number.isFinite(bot.health) && bot.health <= 0) return 'Player died during navigation';
  const oxygen = readOxygenEvidence(bot).oxygen;
  if (oxygen !== null && oxygen <= 10) return 'Low oxygen: navigation stopped; inspect the water and use surface-from-water for a bounded vertical escape';
  const p = bot.entity?.position;
  if ((bot.entity as typeof bot.entity & { isInWater?: boolean })?.isInWater || (p && typeof bot.blockAt === 'function' &&
    (wet(bot.blockAt(p, false)) || wet(bot.blockAt(p.offset(0, 1.62, 0), false))))) {
    return 'Water detected: ordinary navigation is dry-land only; inspect before an explicit bounded surface-from-water action';
  }
  return null;
}

/** Bounded dynamic pathfinder goals use the same hazards as blocking goto. */
export function waitForDryMovement(bot: Bot, durationMs: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 30000) throw new Error('Dynamic movement duration must be 1..30000ms');
  const oxygen = getOxygenAuthority(bot);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true;
      clearTimeout(timer); oxygen?.removeListener('change', check); bot.removeListener('physicsTick', check);
      bot.removeListener('end', ended); bot.removeListener('death', ended); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const check = () => {
      try { const hazard = navigationHazard(bot); if (hazard) finish(new Error(hazard)); }
      catch { finish(new Error('Movement observations became unavailable; controls stopped')); }
    };
    const ended = () => finish(new Error('Session ended or player died during navigation'));
    const abort = () => finish(new Error('Navigation cancelled'));
    const timer = setTimeout(() => finish(), durationMs);
    oxygen?.on('change', check); bot.on('physicsTick', check); bot.on('end', ended); bot.on('death', ended);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else check();
  });
}

type SurfaceColumn = { available: true; surfaceY: number; rise: number } | { available: false; reason: string };

/** Check the entire 0.6-wide vertical swept body, including neighbouring cells.
 * Only source water and empty air are supported; plants, flow, ceilings, unknown
 * chunks, waterlogged blocks and bubble columns fail closed. No blocks are edited. */
function surfaceColumn(bot: Bot, maximumRise: number): SurfaceColumn {
  const p = bot.entity?.position;
  if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) return { available: false, reason: 'Player position is unavailable' };
  for (let y = Math.floor(p.y); y <= Math.floor(p.y + maximumRise) + 2; y++) {
    let entirelyAir = true;
    for (let x = Math.floor(p.x - 0.3); x <= Math.floor(p.x + 0.3); x++) {
      for (let z = Math.floor(p.z - 0.3); z <= Math.floor(p.z + 0.3); z++) {
        const block = bot.blockAt(new Vec3(x, y, z), false);
        if (!block) return { available: false, reason: 'The vertical surface column is not fully loaded' };
        if (!Array.isArray(block.shapes) || block.shapes.length ||
          (!air.has(block.name) && !(block.name === 'water' && Number(block.getProperties().level) === 0))) {
          return { available: false, reason: 'The vertical surface column is blocked or contains unsupported flow/terrain' };
        }
        if (!air.has(block.name)) entirelyAir = false;
      }
    }
    if (entirelyAir) {
      // A second full air layer gives headroom above the waterline, rather than
      // accepting an air pocket immediately under a solid roof.
      let nextAir = true;
      for (let x = Math.floor(p.x - 0.3); x <= Math.floor(p.x + 0.3); x++) {
        for (let z = Math.floor(p.z - 0.3); z <= Math.floor(p.z + 0.3); z++) {
          const next = bot.blockAt(new Vec3(x, y + 1, z), false);
          if (!next || !air.has(next.name) || !Array.isArray(next.shapes) || next.shapes.length) nextAir = false;
        }
      }
      if (!nextAir) return { available: false, reason: 'The surface has blocked or unloaded headroom' };
      const rise = Math.max(0, y - (p.y + 1.62) + 0.1);
      return rise <= maximumRise ? { available: true, surfaceY: y, rise }
        : { available: false, reason: 'The visible surface is beyond the bounded rise limit' };
    }
  }
  return { available: false, reason: 'No clear surface is visible within the bounded rise limit' };
}

export function inspectMovementSafety(bot: Bot): {
  oxygen: number | null; oxygenEvidence: OxygenEvidence; navigationPolicy: 'dry_land_only'; navigationHazard: string | null;
  inWater: boolean; surfaceColumn: SurfaceColumn; liveValidated: false;
} {
  return {
    oxygen: readOxygenEvidence(bot).oxygen, oxygenEvidence: readOxygenEvidence(bot),
    navigationPolicy: 'dry_land_only', navigationHazard: navigationHazard(bot),
    inWater: !!(bot.entity as typeof bot.entity & { isInWater?: boolean })?.isInWater, surfaceColumn: surfaceColumn(bot, 6), liveValidated: false
  };
}

/** An explicit single-lane escape attempt, not a background rescue or shore plan.
 * Only fresh own-player raw metadata revisions can confirm air; the pinned
 * native breath event is unattributed and can originate from another entity.
 * Local physics position alone is never sufficient to confirm oxygen recovery. */
export async function surfaceFromWater(bot: Bot, options: { timeoutMs?: number; maxRise?: number; signal?: AbortSignal } = {}): Promise<{
  requestIssued: boolean; confirmed: boolean; evidence: string[]; detail: string;
  oxygen: number | null; oxygenEvidence: OxygenEvidence; controlsReleased: true; dryLandConfirmed: false; automaticRetry: false;
}> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxRise = options.maxRise ?? 6;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8000) throw new Error('Surfacing timeoutMs must be 1..8000');
  if (!Number.isInteger(maxRise) || maxRise < 1 || maxRise > 8) throw new Error('Surfacing maxRise must be 1..8');
  options.signal?.throwIfAborted();
  const authority = getInventoryAuthority(bot);
  const oxygen = installOxygenAuthority(bot);
  authority.assertMutationReady();
  if (bot.currentWindow || authority.cursor) throw new Error('Close the current window and clear the cursor before surfacing');
  if ((bot as Bot & { vehicle?: unknown }).vehicle) throw new Error('Dismount deliberately before attempting a vertical water escape');
  if (bot.health <= 0) throw new Error('Cannot surface while dead');
  const initial = bot.entity.position.clone();
  const dimension = bot.game?.dimension;
  const column = surfaceColumn(bot, maxRise);
  if (!column.available) throw new Error(column.reason);
  if (!(bot.entity as typeof bot.entity & { isInWater?: boolean }).isInWater && !wet(bot.blockAt(initial, false)) && !wet(bot.blockAt(initial.offset(0, 1.62, 0), false))) {
    throw new Error('The bot is not observed in water; no vertical escape was attempted');
  }
  bot.pathfinder?.setGoal(null);
  bot.clearControlStates();
  const oxygenRevisionBefore = oxygen.snapshot().revision;
  let issued = false;
  let confirmed = false;
  try {
    confirmed = await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = (value: boolean, error?: Error) => {
        if (settled) return; settled = true;
        clearTimeout(timer);
        oxygen.removeListener('change', check); bot.removeListener('physicsTick', check);
        bot.removeListener('death', ended); bot.removeListener('end', ended);
        options.signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const check = () => {
        try {
          if (options.signal?.aborted) return abort();
          authority.assertMutationReady();
          const current = bot.entity.position;
          if (bot.game?.dimension !== dimension || Math.hypot(current.x - initial.x, current.z - initial.z) > 0.45 ||
            current.y < initial.y - 0.5 || current.y > initial.y + maxRise + 1) throw new Error('Surfacing left its inspected vertical column; controls stopped');
          const remaining = surfaceColumn(bot, maxRise);
          if (!remaining.available) throw new Error(remaining.reason);
          const head = bot.blockAt(current.offset(0, 1.62, 0), false);
          const headInAir = !!head && air.has(head.name);
          if (headInAir) bot.setControlState('jump', false);
          else bot.setControlState('jump', true);
          const airEvidence = oxygen.snapshot();
          if (headInAir && airEvidence.known && airEvidence.revision > oxygenRevisionBefore && airEvidence.oxygen !== null && airEvidence.oxygen >= 19) finish(true);
        } catch (error) { finish(false, error instanceof Error ? error : new Error(String(error))); }
      };
      const ended = () => finish(false, new Error('Session ended or player died during surfacing'));
      const abort = () => finish(false, new Error('Surfacing cancelled'));
      const timer = setTimeout(() => finish(false), timeoutMs);
      oxygen.on('change', check); bot.on('physicsTick', check);
      bot.on('death', ended); bot.on('end', ended);
      options.signal?.addEventListener('abort', abort, { once: true });
      issued = true;
      check();
    });
  } finally { bot.clearControlStates(); }
  options.signal?.throwIfAborted();
  authority.assertMutationReady();
  const finalAir = oxygen.snapshot();
  // A second own correction can arrive before this await resumes. Do not retain
  // a transient full-air success after the authoritative sample is invalid/low.
  confirmed = confirmed && finalAir.known && finalAir.revision > oxygenRevisionBefore && finalAir.oxygen !== null && finalAir.oxygen >= 19;
  return {
    requestIssued: issued, confirmed, controlsReleased: true, dryLandConfirmed: false, automaticRetry: false,
    oxygen: finalAir.oxygen, oxygenEvidence: finalAir,
    evidence: confirmed ? ['fresh raw self-entity air metadata with an observed air head position'] : [],
    detail: confirmed ? 'Fresh own-player air supply confirmed; vertical controls released. Reaching dry land is not established.'
      : 'Vertical escape stopped without current fresh own-player air confirmation. Inspect immediately; no route was resumed.'
  };
}
