// Survival-safe adaptations of awesome-mineflayer-mcp tools/beds.ts,
// tools/inventory.ts and tools/vehicles.ts at 89a407ca18a4a39196c6ebe726d5208cff88a9e5.
// Upstream Copyright (c) 2026 Ryker Geesaman, MIT; license retained in
// vendor/awesome-mineflayer-mcp/LICENSE. Additional validation/evidence is local.
// All actions use Mineflayer's public APIs; no invented interaction packets.
import { createRequire } from 'node:module';
import type { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import { getInventoryAuthority, type ServerItem } from './inventory-authority.js';
import { equipVerified } from './verified-inventory.js';
import { withServerBlockConfirmation } from './tools/block-confirmation.js';

const require = createRequire(import.meta.url);
export type Point = { x: number; y: number; z: number };
export type BlockFace = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';
export type InteractionOptions = { signal?: AbortSignal; timeoutMs?: number };
export type ItemSelection = { itemName?: string; inventorySlot?: number };
export type InteractionResult = { requestIssued: boolean; confirmed: boolean; evidence: string[]; detail: string; [key: string]: unknown };
export type BlockExpectation = { position?: Point; name?: string; properties?: Record<string, string | number | boolean> };
export type BlockUseOptions = InteractionOptions & ItemSelection & { face?: BlockFace; cursor?: Point; expect?: BlockExpectation };
type VehicleBot = Bot & { vehicle?: Entity | null };
const faceVectors: Record<BlockFace, Vec3> = { up: new Vec3(0, 1, 0), down: new Vec3(0, -1, 0), north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1), east: new Vec3(1, 0, 0), west: new Vec3(-1, 0, 0) };
const air = new Set(['air', 'cave_air', 'void_air']);

function assertActive(bot: Bot, options: InteractionOptions = {}): void {
  options.signal?.throwIfAborted();
  const authority = getInventoryAuthority(bot);
  authority.assertMutationReady();
  if (bot.currentWindow || authority.cursor) throw new Error('Close containers and clear the cursor before interaction');
  if (bot.health !== undefined && bot.health <= 0) throw new Error('Player is dead; interaction cancelled');
  if (bot.game?.gameMode === 'spectator') throw new Error('Survival interaction unavailable in spectator mode');
}
function timeout(options: InteractionOptions): number {
  const value = options.timeoutMs ?? 3000;
  if (!Number.isFinite(value) || value < 1 || value > 10000) throw new Error('timeoutMs must be between 1 and 10000');
  return value;
}
function blockPosition(point: Point): Vec3 {
  if (![point.x, point.y, point.z].every(Number.isSafeInteger)) throw new Error('Block coordinates must be finite safe integers');
  return new Vec3(point.x, point.y, point.z);
}
function blockAt(bot: Bot, point: Point): Block {
  const block = bot.blockAt(blockPosition(point));
  if (!block) throw new Error('Target chunk is not loaded');
  return block;
}
function dimensionSafety(bot: Bot, block: Block): void {
  if (block.name === 'bed' || block.name.endsWith('_bed')) {
    if (!['overworld', 'minecraft:overworld'].includes(String(bot.game.dimension))) throw new Error('Bed use is allowed only in the Overworld; beds explode in unsafe dimensions');
  }
  if (block.name === 'respawn_anchor') throw new Error('Respawn-anchor activation is not supported by generic block interaction');
}
function clickGeometry(bot: Bot, block: Block, face: BlockFace = 'up', cursor?: Point): { direction: Vec3; cursor: Vec3 } {
  const direction = faceVectors[face];
  if (!direction) throw new Error('Unknown block face');
  const hit = cursor ? new Vec3(cursor.x, cursor.y, cursor.z) : new Vec3(0.5 + direction.x / 2, 0.5 + direction.y / 2, 0.5 + direction.z / 2);
  if (![hit.x, hit.y, hit.z].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error('Cursor coordinates must be between 0 and 1');
  const component = direction.x ? hit.x : direction.y ? hit.y : hit.z;
  const expected = (direction.x || direction.y || direction.z) > 0 ? 1 : 0;
  if (Math.abs(component - expected) > 1e-6) throw new Error('Cursor must lie on the selected block face');
  const eye = bot.entity.position.offset(0, (bot.entity as Entity & { eyeHeight?: number }).eyeHeight ?? 1.62, 0);
  if (eye.distanceTo(block.position.plus(hit)) > 4.5) throw new Error('Block face is outside survival interaction reach (4.5 blocks)');
  if (!bot.canSeeBlock(block)) throw new Error('Block is not visible; move to a clear line of sight first');
  dimensionSafety(bot, block);
  return { direction, cursor: hit };
}
function decoder(bot: Bot): { fromStateId: (stateId: number, biomeId: number) => Block } {
  return require('prismarine-block')(bot.registry);
}
function hasProperties(block: Block, props: Record<string, string | number | boolean>): boolean {
  const current = block.getProperties();
  return Object.entries(props).every(([key, value]) => String(current[key]) === String(value));
}
function isMatching(block: Block, expect: BlockExpectation): boolean {
  return (!expect.name || block.name === expect.name) && (!expect.properties || hasProperties(block, expect.properties));
}
function result(requestIssued: boolean, confirmed: boolean, detail: string, evidence: string[] = [], extra: Record<string, unknown> = {}): InteractionResult {
  return { requestIssued, confirmed, detail, evidence, ...extra };
}

/** Read-only inspection. Properties, unlike name alone, expose doors and crop age. */
export function inspectInteractionBlock(bot: Bot, point: Point): Record<string, unknown> {
  const block = blockAt(bot, point);
  return { name: block.name, stateId: block.stateId, position: block.position, properties: block.getProperties(), visible: bot.canSeeBlock(block), distance: bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)), dimension: bot.game.dimension };
}

/** Explicit slot selection preserves same-name items with different components. */
export async function selectInteractionItem(bot: Bot, selection: ItemSelection, offHand = false, options: InteractionOptions = {}): Promise<ServerItem> {
  assertActive(bot, options);
  const authority = getInventoryAuthority(bot);
  if (bot.currentWindow || authority.cursor) throw new Error('Close containers and clear the cursor before item interaction');
  const frame = authority.getFrame(0);
  const target = offHand ? 45 : 36 + bot.quickBarSlot;
  let slot = selection.inventorySlot;
  if (slot !== undefined && (!Number.isInteger(slot) || slot < 9 || slot > 45)) throw new Error('inventorySlot must be a player inventory slot between 9 and 45');
  if (slot === undefined && selection.itemName) {
    if (frame.slots[target]?.name === selection.itemName) slot = target;
    else {
      const matches = authority.items().filter(item => item.name === selection.itemName);
      if (!matches.length) throw new Error(`No exact ${selection.itemName} in authoritative inventory`);
      if (matches.length > 1) throw new Error(`Multiple ${selection.itemName} stacks; provide inventorySlot`);
      slot = matches[0].slot;
    }
  }
  slot ??= target;
  const chosen = frame.slots[slot];
  if (!chosen || (selection.itemName && chosen.name !== selection.itemName)) throw new Error('Selected authoritative inventory slot does not contain the requested item');
  if (slot !== target || !offHand) {
    if (slot === 45 && !offHand) throw new Error('Move the off-hand item to a storage slot before selecting it in the main hand');
    if (slot !== 45) await equipVerified(bot, slot, offHand ? 'off-hand' : 'hand', timeout(options), { exactSource: selection.inventorySlot !== undefined || !selection.itemName });
  }
  assertActive(bot, options);
  return chosen;
}

/** Force the initial look so activateBlock's internal look cannot await disabled physics.
 * Revalidate after this async boundary before Mineflayer issues its public action. */
async function activateSafely(bot: Bot, block: Block, direction: Vec3, cursor: Vec3, options: InteractionOptions): Promise<void> {
  const handSlot = 36 + bot.quickBarSlot;
  if (getInventoryAuthority(bot).getFrame(0).slots[handSlot]) await selectInteractionItem(bot, { inventorySlot: handSlot }, false, options);
  await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
  assertActive(bot, options);
  const current = blockAt(bot, block.position);
  if (current.stateId !== block.stateId) throw new Error('Target changed before interaction; inspect before retrying');
  const face = (Object.keys(faceVectors) as BlockFace[]).find(key => faceVectors[key].equals(direction))!;
  clickGeometry(bot, current, face, cursor);
  await bot.activateBlock(current, direction, cursor);
}

/** Existing raw-server helper owns block evidence. Its wait is bounded; never retry a toggle. */
async function blockAction(bot: Bot, position: Vec3, accepts: (block: Block) => boolean, operation: () => Promise<void>, options: InteractionOptions): Promise<InteractionResult> {
  const BlockType = decoder(bot);
  let issued = false;
  try {
    await withServerBlockConfirmation(bot, position, state => accepts(BlockType.fromStateId(state, 0)), async () => {
      assertActive(bot, options);
      issued = true;
      await operation();
    }, timeout(options));
    options.signal?.throwIfAborted();
    return result(issued, true, 'Expected block effect confirmed by the server', ['server block-state update'], { position });
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof Error && /Server block change was not confirmed/.test(error.message)) return result(issued, false, error.message, [], { position });
    throw error;
  }
}

export async function activateBlockVerified(bot: Bot, point: Point, options: InteractionOptions & { desiredState?: 'open' | 'closed' | 'on' | 'off'; face?: BlockFace; cursor?: Point } = {}): Promise<InteractionResult> {
  assertActive(bot, options);
  const block = blockAt(bot, point);
  const { direction, cursor } = clickGeometry(bot, block, options.face, options.cursor);
  const openable = /(?:_door|_trapdoor|_fence_gate)$/.test(block.name);
  const switchable = block.name === 'lever' || block.name.endsWith('_button');
  if (!openable && !switchable) throw new Error('Use generic use-item-on-block for other blocks; activate-block supports doors, trapdoors, fence gates, buttons and levers');
  const property = openable ? 'open' : 'powered';
  if (options.desiredState && (openable ? !['open', 'closed'].includes(options.desiredState) : !['on', 'off'].includes(options.desiredState))) throw new Error(`desiredState must be ${openable ? 'open/closed' : 'on/off'} for this block`);
  const before = block.getProperties()[property];
  if (typeof before !== 'boolean') throw new Error(`Block does not expose a boolean ${property} state`);
  const desired = options.desiredState ? ['open', 'on'].includes(options.desiredState) : block.name.endsWith('_button') ? true : !before;
  if (before === desired) return result(false, true, `Block already ${property}=${desired} in the current world snapshot`, ['loaded block state'], { name: block.name, properties: block.getProperties() });
  if (block.name === 'iron_door' || block.name === 'iron_trapdoor') throw new Error('Iron doors and iron trapdoors require redstone; never break them as a fallback');
  if (block.name.endsWith('_button') && !desired) throw new Error('Buttons release automatically; they cannot be switched off by right-clicking');
  if (bot.getControlState('sneak')) throw new Error('Stop sneaking before activating a block');
  return blockAction(bot, block.position, next => next.name === block.name && hasProperties(next, { [property]: desired }), () => activateSafely(bot, block, direction, cursor, options), options);
}

export async function useItemOnBlockVerified(bot: Bot, point: Point, options: BlockUseOptions = {}): Promise<InteractionResult> {
  assertActive(bot, options);
  const block = blockAt(bot, point);
  const { direction, cursor } = clickGeometry(bot, block, options.face, options.cursor);
  // Without an explicit selection this uses the authoritative currently held item,
  // including an empty hand for ordinary block activation.
  if (options.itemName || options.inventorySlot !== undefined) await selectInteractionItem(bot, options, false, options);
  if (options.expect && !options.expect.name && !Object.keys(options.expect.properties ?? {}).length) throw new Error('Block expectation must specify a name or properties');
  const expectedPosition = options.expect ? blockPosition(options.expect.position ?? point) : null;
  if (expectedPosition) blockAt(bot, expectedPosition);
  assertActive(bot, options);
  if (options.expect && expectedPosition) {
    const before = blockAt(bot, expectedPosition);
    if (isMatching(before, options.expect)) throw new Error('Expected block effect already exists; choose a changed property or inspect before retrying');
    return blockAction(bot, expectedPosition, next => isMatching(next, options.expect!), () => activateSafely(bot, block, direction, cursor, options), options);
  }
  await activateSafely(bot, block, direction, cursor, options);
  options.signal?.throwIfAborted();
  return result(true, false, 'Block-use request sent; no expected server effect was specified, so the outcome is unconfirmed');
}

type EvidenceSource = { emitter: EventEmitter; event: string; accepts: (...args: unknown[]) => boolean; description: string };
/** Attach before issuing a request; never treat a locally optimistic property as evidence. */
async function observeEvidence(bot: Bot, sources: EvidenceSource[], operation: () => Promise<void> | void, options: InteractionOptions = {}, holdMs = 0): Promise<string[]> {
  const maxWait = Math.max(timeout(options), holdMs);
  const evidence = new Set<string>();
  let ended: Error | undefined;
  let changed: (() => void) | undefined;
  const listeners = sources.map(source => {
    const listener = (...args: unknown[]) => {
      try { if (source.accepts(...args)) { evidence.add(source.description); changed?.(); } }
      catch (error) { ended = error instanceof Error ? error : new Error(String(error)); changed?.(); }
    };
    source.emitter.on(source.event, listener);
    return { ...source, listener };
  });
  const stop = () => { ended = new Error('Session ended or player died during interaction'); changed?.(); };
  const abort = () => { ended = new Error('Interaction cancelled'); changed?.(); };
  bot.on('end', stop); bot.on('death', stop); options.signal?.addEventListener('abort', abort, { once: true });
  try {
    assertActive(bot, options);
    await operation();
    if (ended) throw ended;
    if (!evidence.size || holdMs) await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const finish = () => { clearTimeout(timer); changed = undefined; if (ended) reject(ended); else resolve(); };
      const timer = setTimeout(finish, maxWait);
      changed = () => { if (ended || (evidence.size && Date.now() - start >= holdMs)) finish(); };
      changed();
    });
    if (ended) throw ended;
    return [...evidence];
  } finally {
    listeners.forEach(source => source.emitter.removeListener(source.event, source.listener));
    bot.removeListener('end', stop); bot.removeListener('death', stop); options.signal?.removeEventListener('abort', abort);
  }
}
function duration(value: number | undefined, max = 5000): number {
  const ms = value ?? 1000;
  if (!Number.isInteger(ms) || ms < 1 || ms > max) throw new Error(`durationMs must be an integer between 1 and ${max}`);
  return ms;
}
function inventoryChangeSource(bot: Bot, slot: number): EvidenceSource {
  const authority = getInventoryAuthority(bot);
  const before = authority.getFrame(0).slots[slot];
  const signature = before ? authority.identity(before, true) : null;
  const revision = authority.getFrame(0).revisions[slot];
  return { emitter: authority, event: 'change', accepts: () => {
    const frame = authority.getFrame(0);
    const current = frame.slots[slot];
    return frame.revisions[slot] > revision && (current ? authority.identity(current, true) : null) !== signature;
  }, description: 'server-confirmed held inventory change (does not prove the requested effect)' };
}

export async function useHeldItemBounded(bot: Bot, options: InteractionOptions & ItemSelection & { offHand?: boolean; durationMs?: number } = {}): Promise<InteractionResult> {
  const ms = duration(options.durationMs);
  await selectInteractionItem(bot, options, options.offHand ?? false, options);
  const slot = options.offHand ? 45 : 36 + bot.quickBarSlot;
  let evidence: string[];
  try {
    evidence = await observeEvidence(bot, [inventoryChangeSource(bot, slot)], () => bot.activateItem(options.offHand ?? false), { ...options, timeoutMs: ms }, ms);
  } finally { stopHeldItem(bot); }
  return result(true, false, 'Held-item use was sent and stopped within the bounded duration; inventory changes are reported separately and do not prove the intended effect', evidence, { durationMs: ms, stopped: true });
}

/** Cleanup must remain usable through safety fences, death and cancellation. */
export function stopHeldItem(bot: Bot): InteractionResult {
  bot.deactivateItem();
  return result(true, false, 'Stop-use request sent; the protocol has no separate acknowledgement of release');
}

function safeBed(bot: Bot, point: Point): Block {
  const block = blockAt(bot, point);
  if (!bot.isABed(block)) throw new Error('Target is not a bed');
  if (bot.getControlState('sneak')) throw new Error('Stop sneaking before using a bed');
  clickGeometry(bot, block);
  return block;
}
export async function sleepInBedVerified(bot: Bot, point: Point, options: InteractionOptions = {}): Promise<InteractionResult> {
  assertActive(bot, options);
  const bed = safeBed(bot, point);
  if (bot.isSleeping) return result(false, true, 'Already sleeping', ['current sleeping state']);
  const handSlot = 36 + bot.quickBarSlot;
  if (getInventoryAuthority(bot).getFrame(0).slots[handSlot]) await selectInteractionItem(bot, { inventorySlot: handSlot }, false, options);
  await bot.lookAt(bed.position.offset(0.5, 0.5, 0.5), true);
  assertActive(bot, options);
  const evidence = await observeEvidence(bot, [{ emitter: bot as unknown as EventEmitter, event: 'sleep', accepts: () => bot.isSleeping, description: 'server-derived sleep event' }], () => bot.sleep(bed), options);
  return result(true, evidence.length > 0, evidence.length ? 'Sleeping confirmed' : 'Sleep request sent but sleep was not confirmed', evidence);
}
export async function wakeVerified(bot: Bot, options: InteractionOptions = {}): Promise<InteractionResult> {
  assertActive(bot, options);
  if (!bot.isSleeping) return result(false, true, 'Already awake', ['current sleeping state']);
  const evidence = await observeEvidence(bot, [{ emitter: bot as unknown as EventEmitter, event: 'wake', accepts: () => !bot.isSleeping, description: 'server-derived wake event' }], () => bot.wake(), options);
  return result(true, evidence.length > 0, evidence.length ? 'Wake confirmed' : 'Wake request sent but waking was not confirmed', evidence);
}
export async function setBedRespawn(bot: Bot, point: Point, options: InteractionOptions = {}): Promise<InteractionResult> {
  assertActive(bot, options);
  const bed = safeBed(bot, point);
  // Vanilla sends a system translation when the point changes. No message can
  // also mean it was already set, so never infer failure or confirmation from silence.
  const evidence = await observeEvidence(bot, [{ emitter: bot as unknown as EventEmitter, event: 'message', accepts: (message: unknown, position: unknown) => {
    if (position !== 'system' && position !== 1) return false;
    const json = (message as { json?: { translate?: string } })?.json;
    return json?.translate === 'block.minecraft.set_spawn' || json?.translate === 'block.minecraft.bed.set_spawn';
  }, description: 'server system message: respawn point set' }], () => activateSafely(bot, bed, faceVectors.up, new Vec3(0.5, 1, 0.5), options), options);
  return result(true, evidence.length > 0, evidence.length ? 'Server reported that the respawn point was set' : 'Bed interaction attempted; respawn point is unconfirmed. Daytime bed use can set respawn without sleeping', evidence, { sleeping: bot.isSleeping });
}

function targetEntity(bot: Bot, id: number): Entity {
  if (!Number.isSafeInteger(id)) throw new Error('entityId must be an integer');
  const entity = bot.entities[id];
  if (!entity || entity.id === bot.entity.id) throw new Error('Target entity is not currently tracked');
  if (entity.type === 'player' || entity.username) throw new Error('Interactions with players are not supported');
  if (bot.entity.position.distanceTo(entity.position) > 3) throw new Error('Entity is outside survival interaction reach (3 blocks)');
  if (!bot.canSeeBlock({ position: entity.position.floored() } as Block)) throw new Error('Entity is not visible; move to a clear line of sight first');
  if (bot.getControlState('sneak')) throw new Error('Stop sneaking before interacting with entities');
  return entity;
}
export async function useOnEntityVerified(bot: Bot, entityId: number, options: InteractionOptions & ItemSelection = {}): Promise<InteractionResult> {
  assertActive(bot, options);
  const entity = targetEntity(bot, entityId);
  const animalNames = new Set(['cow', 'mooshroom', 'sheep', 'pig', 'chicken', 'rabbit', 'wolf', 'cat', 'ocelot', 'horse', 'donkey', 'mule', 'llama', 'trader_llama', 'camel', 'goat', 'turtle', 'fox', 'panda', 'bee', 'axolotl', 'strider', 'hoglin', 'parrot', 'frog', 'sniffer', 'armadillo']);
  if (!entity.name || !animalNames.has(entity.name)) throw new Error('Use-on-entity is restricted to tracked animals');
  await selectInteractionItem(bot, options, false, options);
  const evidence = await observeEvidence(bot, [inventoryChangeSource(bot, 36 + bot.quickBarSlot), { emitter: bot._client, event: 'entity_status', accepts: (value: unknown) => {
    const packet = value as { entityId?: number; entityStatus?: number };
    return packet.entityId === entityId && [6, 7, 18].includes(packet.entityStatus ?? -1);
  }, description: 'server animal interaction status (taming response or love hearts)' }], () => { targetEntity(bot, entityId); bot.useOn(entity); }, options);
  const confirmed = evidence.some(item => item.startsWith('server animal'));
  return result(true, confirmed, confirmed ? 'Animal interaction response observed; offspring, successful taming and ownership are not inferred' : 'Animal-use request sent; no specific animal effect was confirmed', evidence, { entityId });
}
function passengerObservation(bot: Bot, entityId: number, mounted: boolean): { sources: EvidenceSource[]; confirmed: () => boolean } {
  let observed: boolean | undefined;
  const record = (isMounted: boolean) => { observed = isMounted; return isMounted === mounted; };
  return { confirmed: () => observed === mounted, sources: [{ emitter: bot._client, event: 'set_passengers', accepts: (value: unknown) => {
    const packet = value as { entityId?: number; passengers?: number[] };
    if (packet.entityId === -1 && packet.passengers?.includes(bot.entity.id)) return record(false);
    return packet.entityId === entityId && Array.isArray(packet.passengers) && record(packet.passengers.includes(bot.entity.id));
  }, description: 'server passenger list' }, { emitter: bot._client, event: 'attach_entity', accepts: (value: unknown) => {
    const packet = value as { entityId?: number; vehicleId?: number };
    return packet.entityId === bot.entity.id && record(packet.vehicleId === entityId);
  }, description: 'server vehicle attachment' }] };
}
function reconcileDismount(bot: Bot, vehicle: Entity): void {
  // Mineflayer 4.39 does not clear its vehicle cache when set_passengers removes
  // this bot from a nonnegative vehicle ID. Repair only after raw server evidence.
  if ((bot as VehicleBot).vehicle?.id !== vehicle.id) return;
  (bot as VehicleBot).vehicle = null;
  if (bot.entity.vehicle?.id === vehicle.id) Object.assign(bot.entity, { vehicle: null });
  if (vehicle.passengers) vehicle.passengers = vehicle.passengers.filter(passenger => passenger.id !== bot.entity.id);
  bot.emit('dismount', vehicle);
}
export async function mountVerified(bot: Bot, entityId: number, options: InteractionOptions = {}): Promise<InteractionResult> {
  assertActive(bot, options);
  const entity = targetEntity(bot, entityId);
  if (!entity.name || !/(?:^|_)(?:boat|raft|minecart)$/.test(entity.name) && !['horse', 'donkey', 'mule', 'llama', 'trader_llama', 'camel', 'pig', 'strider', 'skeleton_horse', 'zombie_horse'].includes(entity.name)) throw new Error('Target is not a supported rideable entity');
  const vehicle = (bot as VehicleBot).vehicle;
  if (vehicle?.id === entityId) return result(false, true, 'Already mounted on this vehicle', ['server-derived vehicle state']);
  if (vehicle) throw new Error('Dismount the current vehicle first');
  const observation = passengerObservation(bot, entityId, true);
  const evidence = await observeEvidence(bot, observation.sources, () => bot.mount(entity), options);
  const confirmed = evidence.length > 0 && observation.confirmed();
  return result(true, confirmed, confirmed ? 'Mount confirmed' : 'Mount requested but the server attachment was not confirmed', evidence, { entityId });
}
export async function dismountVerified(bot: Bot, options: InteractionOptions = {}): Promise<InteractionResult> {
  assertActive(bot, options);
  const vehicle = (bot as VehicleBot).vehicle;
  if (!vehicle) return result(false, true, 'Already unmounted', ['server-derived vehicle state']);
  const observation = passengerObservation(bot, vehicle.id, false);
  const evidence = await observeEvidence(bot, observation.sources, () => bot.dismount(), options);
  const confirmed = evidence.length > 0 && observation.confirmed();
  if (confirmed) reconcileDismount(bot, vehicle);
  return result(true, confirmed, confirmed ? 'Dismount confirmed' : 'Dismount requested but the server detachment was not confirmed', evidence);
}
export async function steerVehicleBounded(bot: Bot, options: InteractionOptions & { left: number; forward: number; durationMs?: number }): Promise<InteractionResult> {
  assertActive(bot, options);
  const vehicle = (bot as VehicleBot).vehicle;
  if (!vehicle) throw new Error('Bot is not mounted');
  if (![options.left, options.forward].every(v => Number.isFinite(v) && v >= -1 && v <= 1)) throw new Error('Vehicle steering must be between -1 and 1');
  const ms = duration(options.durationMs);
  const initial = vehicle.position.clone();
  const evidenceSources = ['entity_teleport', 'rel_entity_move', 'entity_move_look'].map(event => ({ emitter: bot._client, event, accepts: (value: unknown) => {
    const packet = value as { entityId?: number; dX?: number; dY?: number; dZ?: number; x?: number; y?: number; z?: number };
    return packet.entityId === vehicle.id && (event === 'entity_teleport' ? [packet.x, packet.y, packet.z].every(Number.isFinite) && new Vec3(packet.x!, packet.y!, packet.z!).distanceTo(initial) > 0.01 : Boolean(packet.dX || packet.dY || packet.dZ));
  }, description: 'server vehicle movement update' }));
  let evidence: string[];
  try {
    evidence = await observeEvidence(bot, evidenceSources, () => bot.moveVehicle(options.left, options.forward), { ...options, timeoutMs: ms }, ms);
  } finally { bot.moveVehicle(0, 0); }
  return result(true, evidence.length > 0, evidence.length ? 'Server vehicle movement observed; steering stopped' : 'Steering sent and stopped, but movement was not confirmed', evidence, { durationMs: ms });
}

const cropBlocks: Record<string, { result: string; supports: string[]; face?: BlockFace }> = {
  wheat_seeds: { result: 'wheat', supports: ['farmland'] }, carrot: { result: 'carrots', supports: ['farmland'] }, potato: { result: 'potatoes', supports: ['farmland'] },
  beetroot_seeds: { result: 'beetroots', supports: ['farmland'] }, pumpkin_seeds: { result: 'pumpkin_stem', supports: ['farmland'] }, melon_seeds: { result: 'melon_stem', supports: ['farmland'] },
  nether_wart: { result: 'nether_wart', supports: ['soul_sand'] }, cocoa_beans: { result: 'cocoa', supports: ['jungle_log', 'jungle_wood', 'stripped_jungle_log', 'stripped_jungle_wood'] }
};
export async function farmBlockVerified(bot: Bot, point: Point, options: BlockUseOptions & { action: 'plant' | 'till' | 'bonemeal' | 'bucket' }): Promise<InteractionResult> {
  assertActive(bot, options);
  const block = blockAt(bot, point);
  const geometry = clickGeometry(bot, block, options.face, options.cursor);
  const item = await selectInteractionItem(bot, options, false, options);
  if (options.action === 'plant') {
    const crop = cropBlocks[item.name];
    if (!crop) throw new Error(`No verified planting mapping for ${item.name}`);
    if (!crop.supports.includes(block.name)) throw new Error(`${item.name} cannot be planted on ${block.name}`);
    if (item.name === 'cocoa_beans' ? geometry.direction.y !== 0 : (options.face ?? 'up') !== 'up') throw new Error('Crop planting requires the correct support face');
    const target = block.position.plus(geometry.direction);
    if (!air.has(blockAt(bot, target).name)) throw new Error('Planting target is occupied');
    return useItemOnBlockVerified(bot, point, { ...options, itemName: undefined, inventorySlot: undefined, expect: { position: target, name: crop.result } });
  }
  if (options.action === 'till') {
    if (!item.name.endsWith('_hoe')) throw new Error('Tilling requires a hoe');
    if (!['grass_block', 'dirt', 'dirt_path', 'coarse_dirt', 'rooted_dirt'].includes(block.name)) throw new Error('Block is not tillable soil');
    if ((options.face ?? 'up') === 'down') throw new Error('Cannot till from the bottom face');
    if (!air.has(blockAt(bot, block.position.offset(0, 1, 0)).name)) throw new Error('Clear the block above soil before tilling');
    const expected = ['coarse_dirt', 'rooted_dirt'].includes(block.name) ? 'dirt' : 'farmland';
    return useItemOnBlockVerified(bot, point, { ...options, itemName: undefined, inventorySlot: undefined, expect: { name: expected } });
  }
  if (options.action === 'bonemeal') {
    if (item.name !== 'bone_meal') throw new Error('Bonemeal workflow requires bone_meal');
    return blockAction(bot, block.position, next => next.stateId !== block.stateId, () => activateSafely(bot, block, geometry.direction, geometry.cursor, options), options);
  }
  if (!['bucket', 'water_bucket', 'lava_bucket', 'powder_snow_bucket'].includes(item.name)) throw new Error('Bucket workflow supports empty, water, lava and powder-snow buckets');
  if (String(bot.game.dimension).includes('nether') && item.name === 'water_bucket') throw new Error('Water evaporates in the Nether; no placement will be attempted');
  const useBucket = async () => {
    await bot.lookAt(block.position.plus(geometry.cursor), true);
    assertActive(bot, options);
    bot.activateItem(false);
    bot.deactivateItem();
  };
  if (item.name === 'bucket') {
    if (!['water', 'lava', 'powder_snow'].includes(block.name)) throw new Error('Empty-bucket target must be a fluid source or powder snow');
    if (['water', 'lava'].includes(block.name) && Number(block.getProperties().level) !== 0) throw new Error('Only fluid source blocks can be collected');
    return blockAction(bot, block.position, next => air.has(next.name), useBucket, options);
  }
  const target = block.position.plus(geometry.direction);
  if (!air.has(blockAt(bot, target).name)) throw new Error('Bucket placement target is occupied');
  return blockAction(bot, target, next => next.name === item.name.replace('_bucket', ''), useBucket, options);
}
