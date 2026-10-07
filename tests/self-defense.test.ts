/* eslint-disable @typescript-eslint/no-explicit-any */
import test from 'ava';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { SelfDefense, damageSource, isDefenseMonster, sweepSafe, knownRetreat, safeDefenseStep, defenseRoute, defenseCover, shieldRelativeControls } from '../src/self-defense.js';
import { ToolFactory } from '../src/tool-factory.js';
import { equipVerified } from '../src/verified-inventory.js';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { registerCompleteControls } from '../src/complete-controls.js';
import { interruptible } from '../src/action-interruption.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const flush = async (): Promise<void> => { for (let i = 0; i < 25; i++) await new Promise<void>(r => setImmediate(r)); };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
function fixture(weapon = 'iron_axe') {
  const s = inventoryFixture([{ name: weapon, count: 1, slot: 36 }]);
  const bot = s.bot as any;
  let now = 10000, attacks = 0, shield = 0, interrupted = 0, releases = 0;
  Object.assign(bot, {
    entity: { id: 1, position: new Vec3(.5, 64, .5), onGround: true }, game: { dimension: 'overworld' }, health: 20, food: 20,
    entities: {}, world: { raycast: () => null },
    blockAt: (p: Vec3) => ({ position: p.floored(), name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty', shapes: p.y < 64 ? [[0,0,0,1,1,1]] : [], getProperties: () => ({}) }),
    clearControlStates() {}, stopDigging() {}, setControlState() {}, deactivateItem() { releases++; }, activateItem() { shield++; },
    lookAt: async (point: Vec3) => { const delta=point.minus(bot.entity.position);bot.entity.yaw=Math.atan2(-delta.x,-delta.z); }, attack() { attacks++; },
    pathfinder: { movements: { exclusionAreasStep: [], blocksToAvoid: new Set() }, setMovements(p: any) { this.movements = p; }, setGoal() {}, stop() {}, goto: async () => {} },
    equip: async (item: any, destination: any) => equipVerified(bot, item.slot, destination),
  });
  Object.defineProperty(bot, 'heldItem', { get: () => s.authority.getFrame(0).slots[36 + bot.quickBarSlot] });
  const factory = new ToolFactory({} as any, {} as any);
  const controller = new AbortController();
  const defense = new SelfDefense({ bot, facade: bot, enqueue: op => factory.runInActionLane(op, 'defense'), runAction: op => op(), settings: () => ({ signal: controller.signal }), interrupt: () => { interrupted++; return 'construction'; }, now: () => now });
  const monster = (id = 9, name = 'zombie', x = 2): any => {
    const e = { id, name, type: bot.registry.entitiesByName[name]?.type ?? 'other', position: new Vec3(x, 64, .5), height: 1.8, metadata: [], isValid: true };
    bot.entities[id] = e; return e;
  };
  const hit = (entity?: any, direct = entity?.id ?? -1): void => { bot._client.emit('damage_event', { entityId: 1, sourceCauseId: entity ? entity.id + 1 : 0, sourceDirectId: direct + 1 }); };
  return { ...s, bot, defense, factory, controller, monster, hit, flush,
    advance: async (ms = 250) => { now += ms; bot.emit('physicsTick'); await flush(); },
    counts: () => ({ attacks, shield, interrupted, releases }), now: () => now };
}

test('defense default-off ignores damage; enable uses exact server source including projectile shooter', async t => {
  const s = fixture(); t.teardown(() => s.defense.dispose()); const zombie = s.monster();
  s.hit(zombie); await flush(); t.is(s.counts().attacks, 0);
  s.defense.enable(); s.hit(zombie, 77); await flush();
  t.is(s.counts().attacks, 1); t.is(s.defense.snapshot().state, 'defending');
  t.is(damageSource(s.bot, { entityId: 1, sourceCauseId: zombie.id + 1, sourceDirectId: 78 }), zombie);
  t.is(damageSource(s.bot, { entityId: 2, sourceCauseId: zombie.id + 1, sourceDirectId: 78 }), undefined);
});

test('unknown or projectile-only source never selects nearby monster or retaliates against players', async t => {
  for (const source of ['unknown', 'arrow', 'player']) {
    const s = fixture(); t.teardown(() => s.defense.dispose()); s.monster();
    const cause = source === 'unknown' ? undefined : s.monster(8, source);
    if (cause && source === 'player') cause.type = 'player';
    s.defense.enable(); s.hit(cause, 99); await flush();
    t.is(s.counts().attacks, 0); t.is(s.defense.snapshot().state, 'guarding');
    t.regex(String(s.defense.snapshot().reason), /unknown_or_protected_source/);
  }
});

test('players, pets, neutral, named, owned, riders and invalid/replaced entities fail closed', t => {
  const s = fixture(); t.teardown(() => s.defense.dispose());
  for (const species of ['player', 'wolf', 'cat', 'horse', 'villager', 'iron_golem', 'enderman', 'piglin', 'warden']) t.false(isDefenseMonster(s.bot, s.monster(8, species)));
  for (const fields of [{ username: 'Example' }, { metadata: [null, null, { text: 'Pet' }] }, { customName: '' }, { owner: 'owner' }, { ownerUuid: 'owner' }, { tamed: true }, { passengers: [{}] }, { vehicle: {} }, { isValid: false }, { metadata: undefined }]) t.false(isDefenseMonster(s.bot, Object.assign(s.monster(), fields)));
  const old = s.monster(); s.monster(); t.false(isDefenseMonster(s.bot, old));
});

test('swords refuse all nearby bystanders and axes avoid sweep risk', async t => {
  const s = fixture('iron_sword'); t.teardown(() => s.defense.dispose()); const target = s.monster(); const pet = s.monster(8, 'wolf', 3);
  t.false(sweepSafe(s.bot, target, 'iron_sword')); t.true(sweepSafe(s.bot, target, 'iron_axe'));
  s.defense.enable(); s.hit(target); await flush(); t.is(s.counts().attacks, 0);
  pet.position.x = 20; t.true(sweepSafe(s.bot, target, 'iron_sword'));
});

test('attacks use weapon cooldown and only entityDead confirms target death', async t => {
  const s = fixture(); t.teardown(() => s.defense.dispose()); const target = s.monster();
  s.defense.enable(); s.hit(target); await flush(); await s.advance(250); t.is(s.counts().attacks, 1);
  await s.advance(1000); t.is(s.counts().attacks, 2);
  s.bot.emit('entityDead', target); t.true((s.defense.snapshot().lastOutcome as any).targetDeathConfirmed);
  await s.advance(2000); t.is(s.defense.snapshot().state, 'armed');
  const second = s.monster(10); s.hit(second); await flush(); s.bot.emit('entityGone', second);
  t.false((s.defense.snapshot().lastOutcome as any).targetDeathConfirmed); t.is((s.defense.snapshot().lastOutcome as any).outcome, 'target_lost_not_killed');
});

test('low health, heavy damage, multiple attackers, range and timeout stop attacks', async t => {
  for (const danger of ['health', 'heavy', 'multiple', 'distance', 'timeout']) {
    const s = fixture(); t.teardown(() => s.defense.dispose()); const target = s.monster();
    s.defense.enable(); s.hit(target); await flush(); const before = s.counts().attacks;
    if (danger === 'health') s.bot.health = 8;
    if (danger === 'heavy') s.bot.health = 14;
    if (danger === 'multiple') s.hit(s.monster(10, 'skeleton'));
    if (danger === 'distance') target.position.x = 12;
    await s.advance(danger === 'timeout' ? 13000 : 1500);
    t.is(s.counts().attacks, before, danger); t.true(s.defense.isEnabled, danger); t.true(['guarding', 'retreating', 'cooldown'].includes(String(s.defense.snapshot().state)), danger);
  }
});

test('stop, lifecycle and dimension invalidate queued events without any auto reconnect or respawn', async t => {
  for (const reason of ['disable', 'death', 'end', 'kicked', 'spawn', 'respawn', 'dimension']) {
    const s = fixture(); t.teardown(() => s.defense.dispose()); const target = s.monster(), gate = deferred();
    const work = s.factory.runInActionLane(() => gate.promise);
    s.defense.enable(); s.hit(target);
    if (reason === 'disable') s.defense.disable();
    else if (reason === 'dimension') { s.bot.game.dimension = 'the_nether'; s.bot.emit('physicsTick'); }
    else s.bot.emit(reason);
    gate.resolve(); await work; await flush();
    t.is(s.counts().attacks, 0, reason); t.is(s.defense.snapshot().enabled, false, reason);
  }
});

test('queued damage flood coalesces and cannot starve foreground lane', async t => {
  const factory = new ToolFactory({} as any, {} as any), gate = deferred(), order: string[] = [];
  const first = factory.runInActionLane(() => gate.promise);
  const normal = factory.runInActionLane(async () => { order.push('normal'); });
  const priority = factory.runInActionLane(async () => { order.push('defense1'); }, 'defense');
  const priority2 = factory.runInActionLane(async () => { order.push('defense2'); }, 'defense');
  gate.resolve(); await Promise.all([first, normal, priority, priority2]);
  t.deepEqual(order, ['defense1', 'normal', 'defense2']);
  const s = fixture(); t.teardown(() => s.defense.dispose()); const target = s.monster(), hold = deferred();
  const p = s.factory.runInActionLane(() => hold.promise); s.defense.enable();
  for (let i = 0; i < 100; i++) s.hit(target);
  hold.resolve(); await p; await flush(); t.is(s.counts().attacks, 1); t.is(s.counts().interrupted, 1);
});

test('retreat requires a recent traversed adjacent safe floor, never guessed/unloaded/hazardous routes', t => {
  const s = fixture(); t.teardown(() => s.defense.dispose()); const target = s.monster();
  const route = [{ position: new Vec3(-1, 64, 0), at: s.now() }];
  t.deepEqual(knownRetreat(s.bot, route, s.now(), [target]), route[0].position);
  t.is(knownRetreat(s.bot, route, s.now() + 16000, [target]), undefined);
  t.is(knownRetreat(s.bot, [{ position: new Vec3(1,64,0), at: s.now() }], s.now(), [target]), undefined);
  s.bot.blockAt = () => null; t.is(knownRetreat(s.bot, route, s.now(), [target]), undefined);
});

test('line of sight, unloaded terrain and inventory fence prohibit attack', async t => {
  for (const reason of ['sight', 'unloaded', 'fence']) {
    const s = fixture(); t.teardown(() => s.defense.dispose()); const target = s.monster(); s.defense.enable();
    if (reason === 'sight') s.bot.world.raycast = () => ({});
    if (reason === 'unloaded') s.bot.blockAt = () => null;
    if (reason === 'fence') s.authority.block('fixture uncertainty');
    s.hit(target); await flush(); t.is(s.counts().attacks, 0); t.is(s.defense.snapshot().state, reason === 'fence' ? 'blocked' : 'guarding');
  }
});

async function integrated() {
  const s = fixture(); s.defense.dispose();
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const server = { tool(name: string, _d: string, _s: any, fn: any) { handlers.set(name, fn); } };
  const factory = new ToolFactory(server as any, { checkConnectionAndReconnect: async () => ({ connected: true }) } as any);
  const root = await mkdtemp(join(tmpdir(), 'self-defense-fixture-'));
  const complete = await registerCompleteControls({ bot: s.bot, server, factory, fixture: true, markRead() {}, legacy: new Map(), stateRoot: root });
  return { ...s, factory, complete, handlers, cleanup: async () => { complete.selfDefense.dispose(); await rm(root, { recursive: true, force: true }); } };
}

test.serial('integration: long interruptible navigation is cancelled and settles before defense; construction is not replayed', async t => {
  const s = await integrated(); t.teardown(s.cleanup); const target = s.monster();
  await s.handlers.get('self-defense-enable')!({});
  let aborted = false, settled = false, repeats = 0;
  const started = deferred();
  const task = s.factory.runInActionLane(() => s.complete.runAction(() => interruptible(s.complete.getOptions() as any, async () => {
    repeats++; started.resolve();
    await new Promise<void>(resolve => (s.complete.getOptions().signal!).addEventListener('abort', () => { aborted = true; setImmediate(() => { settled = true; resolve(); }); }, { once: true }));
  }), 'construction-navigation')).catch(e => e);
  await started.promise; s.hit(target); const error = await task; await flush();
  t.regex(error.message, /self-defense/); t.true(aborted); t.true(settled); t.is(repeats, 1); t.is(s.counts().attacks, 1);
  t.is(s.complete.selfDefense.snapshot().interruptedAction, 'construction-navigation');
});

test.serial('integration: submitted inventory or placement stays uncancelled until settlement and is never replayed', async t => {
  for (const label of ['equip_item', 'craft_item', 'click_window', 'place-block']) {
    const s = await integrated(); t.teardown(s.cleanup); const target = s.monster(), gate = deferred(), started = deferred();
    await s.handlers.get('self-defense-enable')!({});
    let signal!: AbortSignal, submitted = 0;
    const task = s.factory.runInActionLane(() => s.complete.runAction(async () => { signal = s.complete.getOptions().signal!; submitted++; started.resolve(); await gate.promise; }, label)).catch(e => e);
    await started.promise; s.hit(target); await flush(); t.false(signal.aborted); t.is(s.counts().attacks, 0);
    gate.resolve(); const error = await task; await flush();
    t.regex(error.message, /submitted operation settled/); t.is(submitted, 1); t.is(s.authority.fence, null); t.is(s.counts().attacks, 1);
  }
});

test.serial('integration: manual stop outranks queued defense and stale damage never reactivates it', async t => {
  const s = await integrated(); t.teardown(s.cleanup); const target = s.monster(), gate = deferred(), started = deferred();
  await s.handlers.get('self-defense-enable')!({});
  const p = s.factory.runInActionLane(() => s.complete.runAction(async () => { started.resolve(); await gate.promise; }, 'critical')).catch(() => {});
  await started.promise; s.hit(target); await s.complete.stop(); gate.resolve(); await p; await flush();
  t.is(s.counts().attacks, 0); t.is(s.complete.selfDefense.snapshot().enabled, false); s.hit(target); await flush(); t.is(s.counts().attacks, 0);
});


test.serial('integration: an enable queued before manual stop cannot turn defense back on', async t => {
  const s = await integrated(); t.teardown(s.cleanup); const gate = deferred(), started = deferred();
  const p = s.factory.runInActionLane(() => s.complete.runAction(async () => { started.resolve(); await gate.promise; }, 'critical')).catch(() => {});
  await started.promise;
  const enabling = s.handlers.get('self-defense-enable')!({});
  await s.complete.stop(); gate.resolve(); await p;
  const result = await enabling; t.true(result.isError); t.regex(result.content[0].text, /superseded/); t.is(s.complete.selfDefense.snapshot().enabled, false);
});

test.serial('integration: enable obeys connection and mutation authority checks', async t => {
  const s = await integrated(); t.teardown(s.cleanup);
  s.authority.block('unconfirmed click');
  const result = await s.handlers.get('self-defense-enable')!({});
  t.true(result.isError); t.is(s.complete.selfDefense.snapshot().enabled, false);
  const handlers = new Map<string, any>(); let enabled = false;
  const factory = new ToolFactory({ tool(name: string, _d: any, _s: any, fn: any) { handlers.set(name, fn); } } as any, { checkConnectionAndReconnect: async () => ({ connected: false }) } as any);
  factory.registerTool('self-defense-enable', '', {}, async () => { enabled = true; return { content: [] }; });
  t.true((await handlers.get('self-defense-enable')({})).isError); t.false(enabled);
});

test('V2 storage weapon is never transferred under damage and no speculative inventory fence is created', async t => {
  const s = fixture(); t.teardown(() => s.defense.dispose()); const target = s.monster();
  s.slots[9] = s.slots[36]; s.slots[36] = null; s.sync();
  s.defense.enable(); s.bot.health = 7; s.hit(target); await flush();
  t.is(s.writes.length, 0); t.is(s.authority.cursor, null); t.is(s.authority.fence, null); t.is(s.counts().attacks, 0); t.true(s.defense.isEnabled);
});


test('protocol 767 codec and pinned entities plugin retain shooter attribution and death versus despawn', t => {
  const require = createRequire(import.meta.url), registry = require('prismarine-registry')('1.21.1');
  const bot = Object.assign(new EventEmitter(), { version: '1.21.1', registry, supportFeature: registry.supportFeature, _client: Object.assign(new EventEmitter(), { username: 'FixtureBot' }), game: { dimension: 'overworld' } }) as any;
  require('mineflayer/lib/plugins/entities')(bot); bot._client.emit('login', { entityId: 1 });
  bot._client.emit('spawn_entity', { entityId: 9, type: registry.entitiesByName.skeleton.id, x: 2, y: 64, z: 1, yaw: 0, pitch: 0, headPitch: 0, objectData: 0, velocity: { x: 0, y: 0, z: 0 } });
  const protocol = require('minecraft-protocol');
  const serializer = protocol.createSerializer({ state: protocol.states.PLAY, isServer: true, version: '1.21.1' });
  const deserializer = protocol.createDeserializer({ state: protocol.states.PLAY, isServer: false, version: '1.21.1' });
  const send = (name: string, params: any): void => { const data = deserializer.parsePacketBuffer(serializer.createPacketBuffer({ name, params })).data; bot._client.emit(data.name, data.params); };
  let source: any; let deaths = 0, gone = 0;
  bot._client.on('damage_event', (packet: any) => { source = damageSource(bot, packet); });
  bot.on('entityDead', () => deaths++); bot.on('entityGone', () => gone++);
  send('damage_event', { entityId: 1, sourceTypeId: 0, sourceCauseId: 10, sourceDirectId: 78, sourcePosition: null });
  t.is(source, bot.entities[9]);
  send('damage_event', { entityId: 1, sourceTypeId: 0, sourceCauseId: 0, sourceDirectId: 78, sourcePosition: { x: 2, y: 64, z: 1 } }); t.is(source, undefined);
  send('entity_status', { entityId: 9, entityStatus: 3 }); t.is(deaths, 1); t.is(gone, 0);
  send('entity_destroy', { entityIds: [9] }); t.is(deaths, 1); t.is(gone, 1);
});

test.serial('integration: manual disable cancels only defense movement and releases continuous shield immediately', async t => {
  const s = await integrated(); t.teardown(s.cleanup); const target = s.monster(9, 'skeleton', 5);
  const require = createRequire(import.meta.url), Item = require('prismarine-item')(s.bot.registry);
  s.slots[45] = new Item(s.bot.registry.itemsByName.shield.id, 1); s.sync();
  const started = deferred(); let cleared = 0;
  s.bot.setControlState = (_key: string, value: boolean) => { if(value) started.resolve(); };
  s.bot.clearControlStates = () => { cleared++; };
  await s.handlers.get('self-defense-enable')!({}); s.hit(target); await started.promise;
  const disabling = s.handlers.get('self-defense-disable')!({});
  t.is(s.counts().releases, 1); await disabling; await flush();
  t.true(cleared>0); t.is(s.counts().attacks, 0); t.false(s.complete.selfDefense.isEnabled); t.is(s.authority.fence, null);
});


test.serial('integration: priority fairness rejects new construction and movement while defense owns the encounter', async t => {
  const s = await integrated(); t.teardown(s.cleanup); const target = s.monster();
  await s.handlers.get('self-defense-enable')!({}); s.hit(target); await flush();
  let constructions = 0, moves = 0;
  s.bot.setControlState = () => { moves++; };
  const construction = s.factory.runInActionLane(() => s.complete.runAction(async () => { constructions++; }, 'place-block'));
  await t.throwsAsync(construction, { message: /self-defense is active/ });
  const move = await s.handlers.get('move-controls')!({ controls: { forward: true }, durationMs: 50 });
  t.true(move.isError); t.is(constructions, 0); t.is(moves, 0);
  s.bot.emit('entityDead', target);
  await s.factory.runInActionLane(() => s.complete.runAction(async () => { constructions++; }, 'place-block'));
  t.is(constructions, 1, 'Only a newly requested action may run after the encounter ends');
});

test('unknown source keeps a cancellable guard without attacking and expires after a quiet lease', async t => {
  const s = fixture(); t.teardown(() => s.defense.dispose()); s.monster();
  const require = createRequire(import.meta.url), Item = require('prismarine-item')(s.bot.registry);
  s.slots[45] = new Item(s.bot.registry.itemsByName.shield.id, 1); s.sync();
  s.defense.enable(); s.hit(); await flush();
  t.is(s.counts().shield, 1); t.true(s.defense.isEnabled); t.is(s.defense.snapshot().state, 'guarding');
  for (let i = 0; i < 5; i++) { s.hit(); await s.advance(2000); }
  t.is(s.counts().shield, 1); t.is(s.counts().attacks, 0); t.true(s.defense.isEnabled);
  await s.advance(8000); t.is(s.counts().releases, 1); t.is(s.defense.snapshot().state, 'cooldown');
  t.false((s.defense.snapshot().lastOutcome as any).targetDeathConfirmed);
});


test('weapon selection reads original durability and selects a healthy same-name hotbar weapon without clicks', async t => {
  const s = fixture(); t.teardown(() => s.defense.dispose()); const target = s.monster();
  const require = createRequire(import.meta.url), Item = require('prismarine-item')(s.bot.registry);
  s.slots[36].components = [{ type: 'damage', data: s.slots[36].maxDurability - 1 }];
  s.slots[38] = new Item(s.bot.registry.itemsByName.iron_axe.id, 1); s.sync();
  const worn = s.authority.getFrame(0).slots[36] as any;
  t.is(worn.durabilityUsed, worn.maxDurability - 1);
  s.defense.enable(); s.hit(target); await flush();
  t.is((s.authority.getFrame(0).slots[38] as any).durabilityUsed, 0);
  t.is((s.authority.getFrame(0).slots[36] as any).durabilityUsed, worn.durabilityUsed); t.is(s.bot.quickBarSlot, 2); t.is(s.writes.length, 0);
  t.is(s.authority.fence, null); t.is(s.counts().attacks, 1);
});

test('V2 attributed distant archer with no safe route keeps facing and shielding under continued arrows', async t => {
  const s = fixture(); t.teardown(() => s.defense.dispose()); const target = s.monster(9, 'skeleton', 9);
  const require = createRequire(import.meta.url), Item = require('prismarine-item')(s.bot.registry);
  s.slots[45] = new Item(s.bot.registry.itemsByName.shield.id, 1); s.sync();
  s.bot.blockAt = () => null;
  let raised = 0, aimed = 0;
  s.bot.activateItem = (offHand: boolean) => { t.true(offHand); raised++; };
  s.bot.lookAt = async (point: Vec3) => { t.is(point.x, target.position.x); aimed++; };
  s.defense.enable(); s.hit(target, 77); await flush();
  for (let i = 0; i < 8; i++) { await s.advance(3000); s.hit(target, 77); await flush(); }
  t.true(s.defense.isEnabled); t.is(s.defense.snapshot().state, 'guarding');
  t.is(raised, 1); t.true(aimed > 1); t.is(s.counts().attacks, 0); t.is(s.counts().releases, 0);
  s.defense.disable(); t.is(s.counts().releases, 1);
});

function armShield(s: ReturnType<typeof fixture>): void {
  const require = createRequire(import.meta.url), Item = require('prismarine-item')(s.bot.registry);
  s.slots[45] = new Item(s.bot.registry.itemsByName.shield.id, 1); s.sync();
}

test('V2 swept route accepts loaded furniture corridors and an overhead slab but rejects floors, ladders, hazards and edges', t => {
  const s = fixture(); t.teardown(() => s.defense.dispose());
  const base = s.bot.blockAt, from = new Vec3(.5,64,.5), to = new Vec3(1.5,64,.5);
  for (const obstacle of ['furniture_beside', 'overhead_slab', 'slab_floor', 'ladder', 'water', 'lava', 'edge', 'unloaded', 'closed_door', 'low_roof']) {
    s.bot.blockAt = (p: Vec3) => {
      const b = base(p);
      if (obstacle === 'furniture_beside' && p.z === 1 && p.y === 64) return { ...b, name: 'chest', shapes: [[0,0,0,1,1,1]] };
      if (obstacle === 'overhead_slab' && p.y === 66) return { ...b, name: 'oak_slab', shapes: [[0,0,0,1,.5,1]] };
      if (p.x === 1 && p.z === 0) {
        if (obstacle === 'unloaded') return null;
        if (obstacle === 'slab_floor' && p.y === 63) return { ...b, name: 'oak_slab', shapes: [[0,0,0,1,.5,1]] };
        if (obstacle === 'edge' && p.y === 63) return { ...b, name: 'air', boundingBox: 'empty', shapes: [] };
        if (['ladder','water','lava','closed_door'].includes(obstacle) && p.y === 64) return { ...b, name: obstacle };
        if (obstacle === 'low_roof' && p.y === 65) return { ...b, name: 'oak_slab', shapes: [[0,0,.5,1,1,1]] };
      }
      return b;
    };
    t.is(safeDefenseStep(s.bot, from, to), ['furniture_beside','overhead_slab'].includes(obstacle), obstacle);
  }
  s.bot.blockAt = base;
  t.false(safeDefenseStep(s.bot, from, new Vec3(1.5,65,.5)));
  t.false(safeDefenseStep(s.bot, from, new Vec3(1.5,64,1.5)));
  t.true(safeDefenseStep(s.bot, new Vec3(.8,64,.7), to));
});

test('V2 short routes prefer loaded two-height cover, permit shielded bounded approach and send no construction', async t => {
  const s = fixture(); t.teardown(() => s.defense.dispose()); const target = s.monster(9,'skeleton',5); armShield(s);
  const origin = s.bot.entity.position.clone();
  t.is(defenseRoute(s.bot, origin, target, [target], true)?.kind, 'approach');
  s.bot.world.raycast = (eye: Vec3, direction: Vec3, distance: number) => eye.plus(direction.scaled(distance)).z > 1 ? {} : null;
  t.is(defenseRoute(s.bot, origin, target, [target], true)?.kind, 'cover');
  t.true(defenseCover(s.bot,new Vec3(.5,64,1.5),[target]));
  s.bot.world.raycast = () => null;
  let controls = 0;
  s.bot.setControlState = (_key: string, value: boolean) => { if(value) controls++; };
  s.bot.pathfinder.goto = () => { t.fail('Guarded movement must not let pathfinder turn the shield away'); };
  s.defense.enable(); s.hit(target,77); await flush();
  s.bot.entity.position.x=1.5; await s.advance(); await s.advance();
  s.bot.entity.position.x=2.5; await s.advance(); await s.advance();
  t.true(controls>0); t.true(s.counts().attacks >= 1); t.is(s.writes.length,0); t.true(s.bot.entity.position.distanceTo(origin)<=4);
});

test('V2 low health never approaches; failed bounded movement never retries and keeps guard', async t => {
  const s = fixture(); t.teardown(() => s.defense.dispose()); const target = s.monster(9,'skeleton',5); armShield(s);
  let movements=0;const base=s.bot.blockAt;
  s.bot.setControlState = (key: string, value: boolean) => { if(value) { movements++;t.is(key,'back'); } };
  s.defense.enable(); s.bot.health=6; s.hit(target,77); await flush();
  s.bot.blockAt=()=>null;await s.advance();s.bot.blockAt=base;
  const after=movements;
  for(let i=0;i<10;i++) { s.hit(target,77); await s.advance(); }
  t.true(movements>0);t.is(movements,after); t.is(s.counts().attacks,0); t.true(s.defense.isEnabled); t.true((s.defense.snapshot().alerts as string[]).includes('short_route_failed_no_automatic_retry'));
});

test('V2 opposite shooters, broken armor/shield and server shield cooldown expose explicit warnings', async t => {
  const s = fixture(); t.teardown(() => s.defense.dispose()); const a = s.monster(9,'skeleton',9), b=s.monster(10,'skeleton',-9); armShield(s);
  const require = createRequire(import.meta.url), Item = require('prismarine-item')(s.bot.registry);
  s.slots[5]=new Item(s.bot.registry.itemsByName.iron_helmet.id,1);s.sync();s.bot.blockAt=()=>null;
  s.defense.enable();s.hit(a,77);await flush();s.hit(b,78);await s.advance();
  t.true((s.defense.snapshot().alerts as string[]).includes('multiple_attackers_shield_cannot_cover_all_directions')); t.is(s.counts().attacks,0);
  s.bot._client.emit('set_cooldown',{itemID:s.bot.registry.itemsByName.shield.id,cooldownTicks:20});await s.advance();
  t.false(s.defense.snapshot().shieldRequestActive);t.true((s.defense.snapshot().alerts as string[]).includes('shield_disabled_by_server_cooldown'));
  await s.advance(1000);t.true(s.defense.snapshot().shieldRequestActive);t.is(s.counts().shield,2);
  s.slots[5]=null;s.slots[45]=null;s.sync();await s.advance();
  t.false(s.defense.snapshot().shieldRequestActive);t.true((s.defense.snapshot().alerts as string[]).includes('armor_broken_or_missing'));t.true((s.defense.snapshot().alerts as string[]).includes('shield_unavailable_or_near_break_no_protection_confirmed'));t.is(s.writes.length,0);
});

test('V2 an inventory fence terminates held guard without clearing it or attacking', async t => {
  const s=fixture();t.teardown(()=>s.defense.dispose());const target=s.monster(9,'skeleton',9);armShield(s);s.bot.blockAt=()=>null;
  s.defense.enable();s.hit(target,77);await flush();s.authority.block('fixture transaction uncertainty');await s.advance();
  t.false(s.defense.isEnabled);t.false(s.defense.snapshot().shieldRequestActive);t.is(s.counts().releases,1);t.is(s.authority.fence,'fixture transaction uncertainty');t.is(s.counts().attacks,0);
});

test('V2 pinned native shield API emits one off-hand use packet, holds between pulses, then one release packet', async t => {
  const s=fixture();t.teardown(()=>s.defense.dispose());const target=s.monster(9,'skeleton',9);armShield(s);s.bot.blockAt=()=>null;
  const require=createRequire(import.meta.url),protocol=require('minecraft-protocol');
  const encoder=protocol.createSerializer({state:'play',isServer:false,version:'1.21.1'}),decoder=protocol.createDeserializer({state:'play',isServer:true,version:'1.21.1'});
  const packets:any[]=[];
  const wire=Object.assign(new EventEmitter(),{registry:s.bot.registry,version:'1.21.1',supportFeature:s.bot.registry.supportFeature,entity:{yaw:0,pitch:0},_client:Object.assign(new EventEmitter(),{write:(name:string,params:any)=>{packets.push(decoder.parsePacketBuffer(encoder.createPacketBuffer({name,params})).data);}})}) as any;
  require('mineflayer/lib/plugins/inventory')(wire,{hideErrors:false});
  s.bot.activateItem=wire.activateItem;s.bot.deactivateItem=wire.deactivateItem;
  s.defense.enable();s.hit(target,77);await flush();for(let i=0;i<8;i++)await s.advance();
  t.deepEqual(packets.map(p=>p.name),['use_item']);t.is(packets[0].params.hand,1);t.true(wire.usingHeldItem);t.false(s.defense.snapshot().shieldEffectConfirmed);
  s.defense.disable();t.deepEqual(packets.map(p=>p.name),['use_item','block_dig']);t.is(packets[1].params.status,5);t.false(wire.usingHeldItem);
});

test.serial('V2 loss of physics pulses expires shield watchdog without leaving held use or a queued loop', async t => {
  const s=fixture();t.teardown(()=>s.defense.dispose());const target=s.monster(9,'skeleton',9);armShield(s);s.bot.blockAt=()=>null;
  s.defense.enable();s.hit(target,77);await flush();await new Promise(resolve=>setTimeout(resolve,2600));
  t.false(s.defense.isEnabled);t.is(s.counts().releases,1);t.is(s.defense.snapshot().reason,'shield_watchdog_expired');
  s.hit(target,77);await flush();t.is(s.counts().shield,1);
});

test('V2 a new arrow during cooldown starts defense immediately; despawn is never a kill', async t => {
  const s=fixture();t.teardown(()=>s.defense.dispose());let target=s.monster(9,'skeleton',9);armShield(s);s.bot.blockAt=()=>null;
  s.defense.enable();s.hit(target,77);await flush();s.bot.emit('entityGone',target);
  t.false((s.defense.snapshot().lastOutcome as any).targetDeathConfirmed);
  target=s.monster(10,'skeleton',9);s.hit(target,78);await s.advance();t.true(s.defense.snapshot().shieldRequestActive);t.is(s.counts().shield,2);t.is(s.counts().attacks,0);
});

test('V2 locked physics moves backwards and sideways while yaw continues to face the shooter', t => {
  const require=createRequire(import.meta.url),{Physics,PlayerState}=require('prismarine-physics');
  for(const [yaw,to,expected] of [[0,new Vec3(.5,64,2.5),'back'],[0,new Vec3(2.5,64,.5),'right'],[-Math.PI/2,new Vec3(-1.5,64,.5),'back']] as const){
    const s=fixture();t.teardown(()=>s.defense.dispose());const Block=require('prismarine-block')(s.bot.registry);
    Object.assign(s.bot.entity,{yaw,pitch:0,velocity:new Vec3(0,0,0),effects:{},attributes:{},height:1.8,width:.6});
    Object.assign(s.bot,{jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0});
    s.bot.blockAt=(point:Vec3)=>{const block=Block.fromProperties(point.y<64?'stone':'air',{},0);block.position=point.floored();return block;};
    const controls=shieldRelativeControls(yaw,s.bot.entity.position,to);t.true(controls[expected]);t.false(controls.jump);t.false(controls.sprint);
    const physics=Physics(s.bot.registry,{getBlock:(point:Vec3)=>s.bot.blockAt(point)}),state=new PlayerState(s.bot,{...controls,sneak:false});
    const before=state.pos.distanceTo(to);
    for(let tick=0;tick<8;tick++)physics.simulatePlayer(state,{getBlock:(point:Vec3)=>s.bot.blockAt(point)});
    t.true(state.pos.distanceTo(to)<before);t.is(state.yaw,yaw);t.true(Math.abs(state.pos.y-64)<.01);
  }
});

test('V2 disable while aim is pending cannot raise shield or write movement keys after cancellation', async t => {
  const s=fixture();t.teardown(()=>s.defense.dispose());const target=s.monster(9,'skeleton',5);armShield(s);
  const gate=deferred(),started=deferred();let keys=0;
  s.bot.lookAt=async()=>{started.resolve();await gate.promise;};s.bot.setControlState=()=>{keys++;};
  s.defense.enable();s.hit(target,77);await started.promise;s.defense.disable();gate.resolve();await flush();
  t.is(s.counts().shield,0);t.is(keys,0);t.is(s.counts().attacks,0);t.false(s.defense.isEnabled);
});

test('V2 successful blocks need no new damage events to keep guarding a visible attributed shooter', async t => {
  const s=fixture();t.teardown(()=>s.defense.dispose());const target=s.monster(9,'skeleton',9);armShield(s);s.bot.entity.onGround=false;
  s.defense.enable();s.hit(target,77);await flush();
  for(let i=0;i<24;i++)await s.advance(1000);
  t.true(s.defense.isEnabled);t.true(s.defense.snapshot().shieldRequestActive);t.is(s.counts().shield,1);t.is(s.counts().releases,0);t.is(s.counts().attacks,0);t.is(s.defense.snapshot().stepsRequested,0);
  t.true((s.defense.snapshot().alerts as string[]).includes('passive_guard_renewed_visible_attributed_threat'));
  s.bot.world.raycast=()=>({});await s.advance(8000);t.is(s.counts().releases,1);t.is(s.defense.snapshot().state,'cooldown');t.false((s.defense.snapshot().lastOutcome as any).targetDeathConfirmed);
});
