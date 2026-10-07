/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { getInventoryAuthority } from './inventory-authority.js';
import { navigationHazard } from './movement-safety.js';

// Vanilla protocol 767 only. No tameable mobs, villagers, golems, bosses or
// neutral mobs without direct damage evidence. Names are species, never chat.
export const DEFENSE_MONSTERS = new Set(['zombie', 'husk', 'drowned', 'zombie_villager',
  'skeleton', 'stray', 'bogged', 'wither_skeleton', 'spider', 'cave_spider',
  'pillager', 'vindicator', 'evoker', 'ravager', 'witch', 'slime', 'magma_cube',
  'silverfish', 'endermite', 'phantom', 'blaze', 'guardian', 'elder_guardian', 'zoglin']);
const NON_LIVING = new Set(['item', 'experience_orb', 'arrow', 'spectral_arrow', 'snowball', 'egg', 'fireball', 'small_fireball']);
const AIR = new Set(['air', 'cave_air', 'void_air']);
const WEAPON = /^(wooden|stone|iron|golden|diamond|netherite)_(axe|sword)$/;
const LIMITS = Object.freeze({ encounterMs: 12000, retreatMs: 4000, reach: 3, leash: 4, lowHealth: 8, maxAttacks: 16, cooldownMs: 1500, guardQuietMs: 8000, shieldWatchdogMs: 2500, maxSteps: 3, approachRange: 6, sourceRange: 24 });
type Damage = { entityId: number; sourceCauseId: number; sourceDirectId: number };
type Crumb = { position: Vec3; at: number };
type Encounter = { epoch: number; target?: any; shieldTarget?: any; origin: Vec3; started: number; lastDamage: number; guardUntil: number; health: number; threats: Set<number>; retreatAt?: number; reason?: string; attacks: number; nextAttack: number; steps: number; armor: number[]; alerts: Set<string> };
export type DefenseState = 'disabled' | 'armed' | 'waiting' | 'defending' | 'retreating' | 'guarding' | 'cooldown' | 'blocked';
type Options = {
  bot: Bot; facade: any;
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  runAction<T>(operation: () => Promise<T>): Promise<T>;
  settings(): { signal?: AbortSignal };
  interrupt(): string | null;
  cancel?(): void;
  report?(status: Record<string, unknown>): void;
  now?: () => number;
};

/** A source id is usable only while the exact observed entity is still alive.
 * Missing sourceCauseId is never repaired with nearest-entity or arrow-heading
 * guesses. For projectiles the server's causing entity is the shooter. */
export function damageSource(bot: Bot, packet: Damage): any | undefined {
  if (packet.entityId !== bot.entity?.id || !Number.isSafeInteger(packet.sourceCauseId) || packet.sourceCauseId <= 0) return undefined;
  const entity = bot.entities[packet.sourceCauseId - 1];
  return isDefenseMonster(bot, entity) ? entity : undefined;
}
export function isDefenseMonster(bot: Bot, entity: any): boolean {
  if (!entity || entity === bot.entity || entity.isValid === false || entity.type !== bot.registry.entitiesByName[entity.name]?.type || entity.type === 'player' || entity.username || !DEFENSE_MONSTERS.has(entity.name)) return false;
  if (bot.entities[entity.id] !== entity || !entity.metadata || entity.metadata[2] != null || entity.customName != null || entity.owner != null || entity.ownerUuid != null || entity.tamed === true) return false;
  if (entity.vehicle || entity.passengers?.length) return false;
  return !!entity.position && [entity.position.x, entity.position.y, entity.position.z].every(Number.isFinite);
}
export function sweepSafe(bot: Bot, target: any, weaponName: string): boolean {
  if (!weaponName.endsWith('_sword')) return true;
  return Object.values(bot.entities).every((entity: any) => entity === target || entity === bot.entity || entity.isValid === false || NON_LIVING.has(entity.name) ||
    (entity.position && entity.position.distanceTo(target.position) > 4 && entity.position.distanceTo(bot.entity.position) > 4));
}
export function clearMeleeSight(bot: Bot, target: any): boolean {
  const eye = bot.entity.position.offset(0, 1.62, 0), aim = target.position.offset(0, Math.min(target.height || 1, 1.4), 0);
  const delta = aim.minus(eye), distance = delta.norm();
  if (!Number.isFinite(distance) || distance > 4 || !bot.world?.raycast) return false;
  if (distance < 0.01) return true;
  const direction = delta.scaled(1 / distance);
  for (let d = 0; d <= distance; d += 0.25) if (!bot.blockAt(eye.plus(direction.scaled(d)), false)) return false;
  return !bot.world.raycast(eye, direction, distance);
}
function safeCell(bot: Bot, point: Vec3): boolean {
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
    const foot = point.offset(x, 0, z), support = bot.blockAt(foot.offset(0, -1, 0), false);
    if (!support || support.boundingBox !== 'block' || !support.shapes?.some(s => s.join(',') === '0,0,0,1,1,1') || /magma|campfire|cactus|ice|slime|honey/.test(support.name) || support.getProperties?.().waterlogged) return false;
    if (![0, 1].every(y => AIR.has(bot.blockAt(foot.offset(0, y, 0), false)?.name ?? ''))) return false;
  }
  return true;
}
/** Fail-closed retreat: recently traversed, level, straight, fully loaded floor.
 * Wider clearance intentionally rejects doors, stairs, edges and narrow ledges. */
export function knownRetreat(bot: Bot, crumbs: Crumb[], now: number, threats: any[]): Vec3 | undefined {
  const here = bot.entity.position.floored();
  if (!bot.entity.onGround || navigationHazard(bot)) return undefined;
  for (const crumb of [...crumbs].reverse()) {
    const to = crumb.position;
    if (now - crumb.at > 15000 || here.y !== to.y || here.distanceTo(to) !== 1) continue;
    if (!safeCell(bot, here) || !safeCell(bot, to)) continue;
    if (threats.some(e => to.offset(0.5, 0, 0.5).distanceTo(e.position) < here.offset(0.5, 0, 0.5).distanceTo(e.position) + 0.25)) continue;
    return to.clone();
  }
  return undefined;
}

/** A one-block cardinal, level, fully observed swept body corridor. Unlike the
 * old 3x3-air test, furniture beside the corridor and roofs above it are allowed.
 * Slab floors, steps, ladders, liquids, doors and missing chunks remain rejected. */
export function safeDefenseStep(bot: Bot, from: Vec3, to: Vec3): boolean {
  if (!bot.entity.onGround || navigationHazard(bot) || Math.abs(from.y - Math.round(from.y)) > 0.01 || from.y !== to.y || from.distanceTo(to) > 1.8 || Math.abs(from.floored().x - to.floored().x) + Math.abs(from.floored().z - to.floored().z) > 1) return false;
  for (let d = 0; d <= 10; d++) {
    const point = from.plus(to.minus(from).scaled(d / 10));
    for (let x = Math.floor(point.x - .3); x <= Math.floor(point.x + .3); x++) for (let z = Math.floor(point.z - .3); z <= Math.floor(point.z + .3); z++) {
      const support = bot.blockAt(new Vec3(x, point.y - 1, z), false);
      if (!support || support.boundingBox !== 'block' || !support.shapes?.some(shape => shape.join(',') === '0,0,0,1,1,1') || /magma|campfire|cactus|ice|slime|honey|powder_snow/.test(support.name) || support.getProperties?.().waterlogged) return false;
      for (const y of [point.y, point.y + 1]) {
        const block = bot.blockAt(new Vec3(x, y, z), false);
        if (!block || !AIR.has(block.name) || block.shapes?.length) return false;
      }
    }
  }
  return true;
}
function observedRay(bot: Bot, eye: Vec3, aim: Vec3): 'clear' | 'blocked' | 'unknown' {
  const delta = aim.minus(eye), distance = delta.norm();
  if (!bot.world?.raycast || !Number.isFinite(distance) || distance > LIMITS.sourceRange) return 'unknown';
  if (distance < .01) return 'clear';
  const direction = delta.scaled(1 / distance);
  for (let d = 0; d <= distance; d += .2) if (!bot.blockAt(eye.plus(direction.scaled(d)), false)) return 'unknown';
  return bot.world.raycast(eye, direction, distance) ? 'blocked' : 'clear';
}
export function defenseCover(bot: Bot, point: Vec3, threats: any[]): boolean {
  return threats.length > 0 && threats.every(target => [0.8, 1.62].every(height => observedRay(bot, target.position.offset(0, Math.min(target.height || 1.8, 1.62), 0), point.offset(0, height, 0)) === 'blocked'));
}
/** Search at most three adjacent cells. Return only the first verified step;
 * all geometry and the exact target are checked again before movement. */
export function defenseRoute(bot: Bot, origin: Vec3, target: any | undefined, threats: any[], allowApproach: boolean, budget: number = LIMITS.maxSteps): { to: Vec3; kind: 'cover' | 'retreat' | 'approach' } | undefined {
  const here = bot.entity.position;
  if (Math.abs(here.y - Math.round(here.y)) > .01) return;
  const queue = [{ point: here.clone(), route: [] as Vec3[] }], seen = new Set([here.toString()]);
  const bystanders = Object.values(bot.entities).filter((entity: any) => entity !== bot.entity && entity !== target && entity.isValid !== false && !NON_LIVING.has(entity.name) && entity.position);
  let approach: Vec3 | undefined, retreat: Vec3 | undefined;
  for (let index = 0; index < queue.length && index < 85; index++) {
    const { point, route } = queue[index];
    if (route.length) {
      if (defenseCover(bot, point, threats)) return { to: route[0], kind: 'cover' };
      if (threats.length && threats.every(t => point.distanceTo(t.position) >= here.distanceTo(t.position) + .75)) retreat ??= route[0];
      if (allowApproach && target && here.distanceTo(target.position) <= LIMITS.approachRange && point.distanceTo(target.position) <= LIMITS.reach && observedRay(bot, point.offset(0, 1.62, 0), target.position.offset(0, 1.4, 0)) === 'clear') approach ??= route[0];
    }
    if (route.length >= Math.min(LIMITS.maxSteps, budget)) continue;
    for (const [x, z] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const to = point.floored().offset(x + .5, 0, z + .5), key = to.toString();
      if (seen.has(key) || to.distanceTo(origin) > LIMITS.leash || threats.some(t => to.distanceTo(t.position) < 1.5) || bystanders.some(entity => to.distanceTo(entity.position) < 1.5) || !safeDefenseStep(bot, point, to)) continue;
      seen.add(key); queue.push({ point: to, route: [...route, to] });
    }
  }
  if (approach) return { to: approach, kind: 'approach' };
  if (retreat) return { to: retreat, kind: 'retreat' };
  return;
}

/** Minecraft yaw-relative ordinary movement keys. No jump, sprint or physics
 * overrides: retreat can walk backwards while the shield keeps facing a source. */
export function shieldRelativeControls(yaw: number, from: Vec3, to: Vec3): Record<string, boolean> {
  const delta = to.minus(from), length = Math.hypot(delta.x, delta.z);
  if (!Number.isFinite(yaw) || length < .01) return { forward: false, back: false, left: false, right: false, jump: false, sprint: false };
  const forward = (-delta.x * Math.sin(yaw) - delta.z * Math.cos(yaw)) / length;
  const right = (delta.x * Math.cos(yaw) - delta.z * Math.sin(yaw)) / length;
  return { forward: forward > .3827, back: forward < -.3827, right: right > .3827, left: right < -.3827, jump: false, sprint: false };
}

/** Event-driven, default-off and session-only. Each pulse owns the shared lane
 * until all verified operations settle. It never invokes the unbounded PVP plugin. */
export class SelfDefense {
  private readonly now: () => number;
  private enabled = false;
  private state: DefenseState = 'disabled';
  private reason = 'not_enabled';
  private epoch = 0;
  private pending = false;
  private lastPulse = -Infinity;
  private cooldownUntil = 0;
  private dimension = '';
  private encounter?: Encounter;
  private crumbs: Crumb[] = [];
  private healthSamples: Array<{ at: number; health: number }> = [];
  private lastOutcome: Record<string, unknown> | null = null;
  private interruptedAction: string | null = null;
  private shieldOwned = false;
  private stopStep?: () => void;
  private shieldBlockedUntil = 0;
  private lastTransitionSignature = '';
  private shieldWatchdog?: ReturnType<typeof setTimeout>;
  private readonly authority;
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.authority = getInventoryAuthority(options.bot);
    options.bot._client.on('damage_event', this.hurt);
    options.bot._client.on('set_cooldown', this.shieldCooldown);
    options.bot.on('entityDead', this.dead);
    options.bot.on('entityGone', this.gone);
    options.bot.on('physicsTick', this.tick);
    options.bot.on('health', this.health);
    for (const event of ['death', 'end', 'kicked', 'respawn', 'spawn']) options.bot.on(event as any, this.lifecycle);
  }
  get busy(): boolean { return !!this.encounter; }
  get isEnabled(): boolean { return this.enabled; }
  snapshot(): Record<string, unknown> {
    const e = this.encounter;
    return { implementation: 'ranged-defense-v2', enabled: this.enabled, state: this.state, reason: this.reason, target: e?.target ? { id: e.target.id, species: e.target.name } : null,
      attacksRequested: e?.attacks ?? 0, targetDeathConfirmed: false, interruptedAction: this.interruptedAction, automaticResume: false,
      lastOutcome: this.lastOutcome, limits: LIMITS, liveValidated: false, shieldRequestActive: this.shieldOwned, shieldEffectConfirmed: false, alerts: e ? [...e.alerts] : [], stepsRequested: e?.steps ?? 0, guardLeaseRemainingMs: e ? Math.max(0, e.guardUntil - this.now()) : 0 };
  }
  captureEnableGuard(): () => void {
    const epoch = this.epoch;
    return () => { if (this.epoch !== epoch) throw Error('Enable request was superseded by a stop or session change; request enable again explicitly'); };
  }
  enable(): Record<string, unknown> {
    const bot = this.options.bot;
    if (bot.registry.version.version !== 767 || bot.version !== '1.21.1') throw Error('Self-defense supports Java 1.21.1 / protocol 767 only');
    this.authority.assertMutationReady();
    if (!bot.entity || !Number.isFinite(bot.health) || bot.health <= LIMITS.lowHealth || bot.currentWindow || this.authority.cursor) throw Error('Self-defense needs a live healthy player, closed window and empty cursor');
    if (this.options.facade.pvp?.target) throw Error('Stop the existing PVP plugin before enabling reactive defense');
    if (this.busy) return this.snapshot();
    this.epoch++; this.enabled = true; this.dimension = String(bot.game?.dimension); this.crumbs = []; this.healthSamples = []; this.lastOutcome = null; this.interruptedAction = null;
    this.transition('armed', 'waiting_for_server_damage'); this.sample(); return this.snapshot();
  }
  disable(reason = 'user_disabled'): Record<string, unknown> {
    this.stopStep?.(); this.options.cancel?.();
    this.epoch++; this.enabled = false; this.encounter = undefined; this.crumbs = []; this.healthSamples = [];
    this.releaseShield(); this.transition('disabled', reason); return this.snapshot();
  }
  private shieldCooldown = (packet: { itemID: number; cooldownTicks: number }): void => {
    if (packet.itemID !== this.options.bot.registry.itemsByName.shield?.id || !Number.isInteger(packet.cooldownTicks) || packet.cooldownTicks < 0) return;
    this.shieldBlockedUntil = this.now() + packet.cooldownTicks * 50;
    if (packet.cooldownTicks > 0) { this.releaseShield(); this.encounter?.alerts.add('shield_disabled_by_server_cooldown'); }
  };
  private lifecycle = (): void => { this.disable('session_lifecycle_changed'); };
  private health = (): void => {
    if (!this.enabled) return;
    this.healthSamples.push({ at: this.now(), health: this.options.bot.health });
    this.healthSamples = this.healthSamples.filter(s => this.now() - s.at <= 2000).slice(-20);
  };
  private valid(e: Encounter): boolean { return this.enabled && this.encounter === e && this.epoch === e.epoch; }
  private check(e: Encounter): void {
    if (!this.valid(e)) throw Error('Self-defense episode is no longer current');
    this.options.settings().signal?.throwIfAborted();
    this.authority.assertMutationReady();
    if (String(this.options.bot.game?.dimension) !== this.dimension || this.options.bot.health <= 0) throw Error('Self-defense session changed');
    if (this.options.bot.currentWindow || this.authority.cursor) throw Error('Inventory/window requires inspection before defense');
  }
  private hurt = (packet: Damage): void => {
    const bot = this.options.bot;
    if (!this.enabled || packet.entityId !== bot.entity?.id) return;
    if (String(bot.game?.dimension) !== this.dimension) { this.lifecycle(); return; }
    const target = damageSource(bot, packet);
    let e = this.encounter;
    if (!e) {
      e = { epoch: ++this.epoch, target, origin: bot.entity.position.clone(), started: this.now(), lastDamage: this.now(), guardUntil: this.now() + LIMITS.guardQuietMs, health: bot.health, threats: new Set(), attacks: 0, nextAttack: this.now(), steps: 0, armor: [5,6,7,8].filter(slot => !!this.authority.getFrame(0).slots[slot]), alerts: new Set() };
      this.encounter = e;
      try { this.interruptedAction = this.options.interrupt(); }
      catch { this.finish(e, 'foreground_interrupt_cleanup_failed', false, true); return; }
      this.transition('waiting', target ? 'server_damage_source' : 'unknown_or_protected_source');
    }
    e.lastDamage = this.now(); e.guardUntil = this.now() + LIMITS.guardQuietMs;
    if (target) { e.threats.add(target.id); e.shieldTarget = target; }
    if (!target) e.alerts.add('unknown_or_protected_source_no_retaliation');
    if (e.threats.size > 1) e.alerts.add('multiple_attackers_shield_cannot_cover_all_directions');
    if (!target || e.threats.size > 1) this.retreat(e, !target ? 'unknown_or_protected_source' : 'multiple_attackers');
    this.schedule();
  };
  private dead = (entity: any): void => {
    const e = this.encounter;
    if (e && e.target === entity) this.finish(e, 'target_death_observed', true);
  };
  private gone = (entity: any): void => {
    const e = this.encounter;
    if (e && e.target === entity) this.finish(e, 'target_lost_not_killed', false);
  };
  private sample(): void {
    const bot = this.options.bot, point = bot.entity?.position?.floored();
    if (!point || this.encounter || !bot.entity.onGround || navigationHazard(bot) || !safeCell(bot, point)) return;
    const last = this.crumbs.at(-1);
    if (!last || !last.position.equals(point)) this.crumbs.push({ position: point, at: this.now() });
    this.crumbs = this.crumbs.filter(c => this.now() - c.at <= 15000).slice(-24);
    this.health();
  }
  private tick = (): void => {
    try { this.tickSafely(); } catch { const e=this.encounter;if(e)this.finish(e,'defense_observation_unavailable',false,true);else this.disable('defense_observation_unavailable'); }
  };
  private tickSafely(): void {
    if (!this.enabled) return;
    if (String(this.options.bot.game?.dimension) !== this.dimension) { this.lifecycle(); return; }
    if (!this.encounter) {
      if (this.state === 'cooldown' && this.now() >= this.cooldownUntil) this.transition('armed', 'waiting_for_server_damage');
      this.sample(); return;
    }
    this.schedule();
  }
  private schedule(): void {
    const e = this.encounter;
    if (!e || this.pending || this.now() - this.lastPulse < 200) return;
    this.pending = true; this.lastPulse = this.now();
    void this.options.enqueue(async () => {
      if (!this.valid(e)) return;
      await this.options.runAction(() => this.pulse(e));
    }).catch(error => {
      if (this.valid(e)) this.finish(e, 'blocked: ' + String(error.message ?? error).slice(0, 180), false, true);
    }).finally(() => { this.pending = false; });
  }
  private retreat(e: Encounter, reason: string): void {
    const changed = e.retreatAt === undefined || e.reason !== reason;
    e.retreatAt ??= this.now(); e.reason = reason;
    if (reason === 'low_health_or_heavy_damage') e.alerts.add(reason);
    if (changed) this.transition('retreating', e.reason);
  }
  private usableWeapon(item: any): boolean {
    return !!item && WEAPON.test(item.name) && Number.isFinite(item.maxDurability) && Number.isFinite(item.durabilityUsed) && item.maxDurability - item.durabilityUsed > 3;
  }
  private async equip(e: Encounter): Promise<string | undefined> {
    const bot = this.options.bot, facade = this.options.facade, frame = this.authority.getFrame(0);
    // Combat is not the time for a multi-click storage transaction. Keep a safe
    // held weapon, then select only an already-observed hotbar weapon (zero clicks).
    const held = frame.slots[36 + bot.quickBarSlot];
    if (this.usableWeapon(held) && (!e.target || sweepSafe(bot, e.target, held!.name))) return held!.name;
    const items = this.authority.items().filter(i => i.slot >= 36 && this.usableWeapon(frame.slots[i.slot]) && (!e.target || sweepSafe(bot, e.target, i.name)));
    items.sort((a, b) => Number(b.name.endsWith('_axe')) - Number(a.name.endsWith('_axe')));
    const weapon = items[0];
    if (weapon) { this.releaseShield(); await facade.equip(weapon, 'hand'); this.check(e); }
    else e.alerts.add('no_ready_hotbar_weapon_prepare_equipment_before_enabling');
    return weapon?.name;
  }
  private async shield(e: Encounter): Promise<void> {
    this.check(e);
    if (this.now() < this.shieldBlockedUntil) { this.releaseShield(); e.alerts.add('shield_disabled_by_server_cooldown'); return; }
    e.alerts.delete('shield_disabled_by_server_cooldown');
    const shield = this.authority.getFrame(0).slots[45] as any;
    if (shield?.name !== 'shield' || !Number.isFinite(shield.maxDurability) || !Number.isFinite(shield.durabilityUsed) || shield.maxDurability - shield.durabilityUsed <= 1) {
      this.releaseShield(); e.alerts.add('shield_unavailable_or_near_break_no_protection_confirmed'); return;
    }
    const target = e.shieldTarget;
    if (target && isDefenseMonster(this.options.bot, target) && target.position.distanceTo(this.options.bot.entity.position) <= LIMITS.sourceRange) {
      await this.options.facade.lookAt(target.position.offset(0, Math.min(target.height || 1, 1.4), 0), true); this.check(e);
    }
    e.alerts.delete('shield_unavailable_or_near_break_no_protection_confirmed');
    if (!this.shieldOwned) {
      this.shieldOwned = true;
      try { this.options.facade.activateItem(true); }
      catch (error) { this.releaseShield(); throw error; }
    }
    clearTimeout(this.shieldWatchdog);
    // Do not leave continuous item use behind if physics/queue updates cease.
    this.shieldWatchdog = setTimeout(() => { if (this.valid(e)) this.finish(e, 'shield_watchdog_expired', false, true); }, LIMITS.shieldWatchdogMs);
    this.shieldWatchdog.unref?.();
  }
  private releaseShield(): void {
    clearTimeout(this.shieldWatchdog); this.shieldWatchdog = undefined;
    if (this.shieldOwned) { this.shieldOwned = false; try { this.options.facade.deactivateItem(); } catch { this.authority.block('Self-defense shield cleanup failed; inspect before another mutation'); } }
  }
  private async pulse(e: Encounter): Promise<void> {
    this.check(e);
    const bot = this.options.bot, facade = this.options.facade, now = this.now();
    for (const slot of e.armor) if (!this.authority.getFrame(0).slots[slot]) e.alerts.add('armor_broken_or_missing');
    if (now >= e.guardUntil) {
      const source = e.shieldTarget;
      // Successful blocks may emit no damage_event. Do not periodically drop
      // the shield while the already-attributed attacker remains in clear sight.
      // This renews passive guard only, never an attack or movement budget.
      if (source && isDefenseMonster(bot, source) && observedRay(bot, source.position.offset(0, 1.4, 0), bot.entity.position.offset(0, 1.62, 0)) === 'clear') {
        e.guardUntil = now + LIMITS.guardQuietMs;
        e.alerts.add('passive_guard_renewed_visible_attributed_threat');
      } else { this.finish(e, 'damage_quiet_no_kill_claim', false); return; }
    }
    const healthDrop = Math.max(e.health, ...this.healthSamples.map(s => s.health)) - bot.health;
    if (bot.health <= LIMITS.lowHealth || healthDrop >= 6) this.retreat(e, 'low_health_or_heavy_damage');
    else if (now - e.started >= LIMITS.encounterMs || e.attacks >= LIMITS.maxAttacks) this.retreat(e, 'combat_limit');
    else if (bot.entity.position.distanceTo(e.origin) > LIMITS.leash) this.retreat(e, 'distance_limit');
    if (e.target && !isDefenseMonster(bot, e.target)) { this.finish(e, 'target_no_longer_safe', false); return; }
    if (e.retreatAt !== undefined) { await this.retreatPulse(e); return; }
    const weapon = await this.equip(e); this.check(e);
    if (bot.health <= LIMITS.lowHealth || Math.max(e.health, ...this.healthSamples.map(s => s.health)) - bot.health >= 6) this.retreat(e, 'low_health_or_heavy_damage');
    if (this.now() - e.started >= LIMITS.encounterMs) this.retreat(e, 'combat_limit');
    if (e.retreatAt !== undefined) { await this.retreatPulse(e); return; }
    if (!weapon || !e.target) { this.retreat(e, 'no_safe_weapon_or_source'); await this.retreatPulse(e); return; }
    if (bot.entity.position.distanceTo(e.target.position) > LIMITS.reach || !clearMeleeSight(bot, e.target)) {
      await this.guardPulse(e, 'attributed_target_outside_clear_melee_reach', true); return;
    }
    this.transition('defending', 'bounded_melee');
    if (this.now() < e.nextAttack) { await this.shield(e); return; }
    await facade.lookAt(e.target.position.offset(0, Math.min(e.target.height || 1, 1.4), 0), true); this.check(e);
    if (this.now() - e.started >= LIMITS.encounterMs || bot.health <= LIMITS.lowHealth || Math.max(e.health, ...this.healthSamples.map(s => s.health)) - bot.health >= 6 || e.retreatAt !== undefined || facade.heldItem?.name !== weapon || !this.usableWeapon(facade.heldItem) || !isDefenseMonster(bot, e.target) || bot.entity.position.distanceTo(e.target.position) > LIMITS.reach || !clearMeleeSight(bot, e.target) || !sweepSafe(bot, e.target, facade.heldItem?.name ?? '')) { this.retreat(e, 'attack_recheck_failed'); return; }
    this.releaseShield();
    facade.attack(e.target);
    e.attacks++; e.nextAttack = this.now() + (weapon.endsWith('_axe') ? 1250 : 700);
    await this.shield(e);
  }
  private async retreatPulse(e: Encounter): Promise<void> {
    await this.guardPulse(e, e.reason ?? 'retreat_required', false);
  }
  private async guardPulse(e: Encounter, reason: string, allowApproach: boolean): Promise<void> {
    this.check(e);
    const bot = this.options.bot;
    await this.shield(e); this.check(e);
    const threats = Object.values(bot.entities).filter((entity: any) => e.threats.has(entity.id) && isDefenseMonster(bot, entity));
    let route: ReturnType<typeof defenseRoute>;
    const moveAllowed = e.steps < LIMITS.maxSteps && (e.retreatAt === undefined || this.now() - e.retreatAt < LIMITS.retreatMs) && this.now() - e.started < LIMITS.encounterMs;
    if (defenseCover(bot, bot.entity.position, threats)) {
      e.alerts.delete('no_verified_escape_holding_guard_needs_attention');
      this.transition('guarding', 'observed_cover_guard_unconfirmed'); return;
    }
    if (moveAllowed && threats.length) route = defenseRoute(bot, e.origin, e.target, threats, allowApproach && this.shieldOwned && e.threats.size === 1, LIMITS.maxSteps - e.steps);
    if (!route) {
      e.alerts.add('no_verified_escape_holding_guard_needs_attention');
      this.transition('guarding', reason + (this.shieldOwned ? ': holding_shield_unconfirmed' : ': shield_unavailable')); return;
    }
    e.alerts.delete('no_verified_escape_holding_guard_needs_attention');
    const to = route.to, from = bot.entity.position.clone();
    if (!safeDefenseStep(bot, from, to)) { this.transition('guarding', 'safe_route_changed'); return; }
    e.steps++;
    this.transition('retreating', 'verified_short_' + route.kind);
    try { await this.moveGuardedStep(e, from, to, route.kind === 'approach'); }
    catch (error) {
      if (!this.valid(e)) throw error;
      this.check(e); e.steps = LIMITS.maxSteps; e.alerts.add('short_route_failed_no_automatic_retry');
    }
    this.check(e); await this.shield(e);
    this.transition('guarding', 'short_route_settled_guard_unconfirmed');
  }
  private async moveGuardedStep(e: Encounter, from: Vec3, to: Vec3, approaching: boolean): Promise<void> {
    const bot = this.options.bot, facade = this.options.facade, signal = this.options.settings().signal;
    let settled = false, update: Promise<void> | undefined, failure: Error | undefined;
    let complete!: () => void;
    const done = new Promise<void>(resolve => { complete = resolve; });
    const finish = (error?: Error) => { if (settled) return; settled = true; failure = error; facade.clearControlStates(); complete(); };
    const cancel = () => finish(new Error('Guarded movement cancelled'));
    const tick = () => {
      if (settled || update) return;
      update = (async () => {
        this.check(e);
        if (!safeDefenseStep(bot, from, to) || !safeDefenseStep(bot, from, bot.entity.position) || bot.entity.position.distanceTo(e.origin) > LIMITS.leash) throw Error('Guarded corridor changed');
        if (approaching && (e.retreatAt !== undefined || bot.health <= LIMITS.lowHealth || e.threats.size !== 1)) throw Error('Approach safety conditions changed');
        if (bot.entity.position.distanceTo(to) <= .22) { finish(); return; }
        await this.shield(e); this.check(e);
        if (approaching && !this.shieldOwned) throw Error('Approach requires a ready shield');
        if (settled) return;
        // lookAt above owns orientation; never let pathfinder turn away from
        // the shooter. Only six ordinary direction keys are written here.
        const keys = shieldRelativeControls(bot.entity.yaw, bot.entity.position, to);
        for (const [key, value] of Object.entries(keys)) facade.setControlState(key, value);
      })().catch(error => finish(error instanceof Error ? error : new Error(String(error)))).finally(() => { update = undefined; });
    };
    const timer = setTimeout(() => finish(new Error('Guarded step timed out after 1500ms; no automatic retry')), 1500);
    this.stopStep = cancel;
    facade.pathfinder.setGoal(null); facade.clearControlStates();
    bot.on('physicsTick', tick); signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (signal?.aborted) cancel(); else tick();
      await done; await update;
      if (failure) throw failure;
    } finally {
      clearTimeout(timer); bot.removeListener('physicsTick', tick); signal?.removeEventListener('abort', cancel);
      if (this.stopStep === cancel) this.stopStep = undefined;
      facade.clearControlStates();
    }
  }
  private finish(e: Encounter, outcome: string, deathObserved: boolean, block = false): void {
    if (!this.valid(e)) return;
    this.stopStep?.(); this.options.cancel?.();
    this.lastOutcome = { outcome, targetDeathConfirmed: deathObserved, attacksRequested: e.attacks, stepsRequested: e.steps, alerts: [...e.alerts], interruptedAction: this.interruptedAction, automaticResume: false };
    this.encounter = undefined; this.epoch++; this.releaseShield();
    if (block) { this.enabled = false; this.transition('blocked', outcome); }
    else { this.cooldownUntil = this.now() + LIMITS.cooldownMs; this.transition('cooldown', outcome); }
  }
  private transition(state: DefenseState, reason: string): void {
    const signature = JSON.stringify([state, reason, this.shieldOwned, [...(this.encounter?.alerts ?? [])]]);
    if (this.lastTransitionSignature === signature) return;
    this.lastTransitionSignature = signature;
    this.state = state; this.reason = reason; this.options.report?.(this.snapshot());
  }
  dispose(): void {
    this.disable('disposed');
    const bot = this.options.bot;
    bot._client.removeListener('set_cooldown', this.shieldCooldown);
    bot._client.removeListener('damage_event', this.hurt); bot.removeListener('entityDead', this.dead); bot.removeListener('entityGone', this.gone);
    bot.removeListener('physicsTick', this.tick); bot.removeListener('health', this.health);
    for (const event of ['death', 'end', 'kicked', 'respawn', 'spawn']) bot.removeListener(event as any, this.lifecycle);
  }
}
