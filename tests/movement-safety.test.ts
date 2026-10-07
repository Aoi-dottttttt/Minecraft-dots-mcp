import test from 'ava';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import sinon from 'sinon';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import { ToolFactory } from '../src/tool-factory.js';
import { registerCompleteControls } from '../src/complete-controls.js';
import { registerPositionTools } from '../src/tools/position-tools.js';
import { installOxygenAuthority } from '../src/oxygen-authority.js';
import { inventoryFixture } from './helpers/inventory-fixture.js';
import { constrainMovements, inspectMovementSafety, surfaceFromWater, waitForDryMovement } from '../src/movement-safety.js';
import { moveAndVerify } from '../src/tools/movement-utils.js';

const require = createRequire(import.meta.url);
function fixture() {
  const f = inventoryFixture([]);
  const Block = require('prismarine-block')(f.bot.registry);
  const controls: Record<string, boolean> = {};
  let waterTop = 65;
  let ceiling = false;
  let loaded = true;
  const blockAt = (point: Vec3) => {
    if (!loaded) return null;
    const p = point.floored();
    const block = Block.fromProperties(ceiling && p.y === waterTop + 1 ? 'stone' : p.y <= waterTop ? 'water' : 'air', {}, 0);
    block.position = p;
    return block;
  };
  Object.assign(f.bot, {
    entity: { id: 10, position: new Vec3(0.5, 64, 0.5), height: 1.8, isInWater: true },
    oxygenLevel: 8, health: 20, game: { dimension: 'overworld', gameMode: 'survival' },
    blockAt, vehicle: null,
    setControlState: (key: string, value: boolean) => { controls[key] = value; },
    clearControlStates: () => { for (const key of Object.keys(controls)) controls[key] = false; },
    pathfinder: { setGoal: () => {}, movements: undefined }
  });
  const oxygenAuthority = installOxygenAuthority(f.bot);
  const setAir = (value: number, entityId = f.bot.entity.id) => f.bot._client.emit('entity_metadata', { entityId, metadata: [{ key: 1, type: 'int', value }] });
  setAir(120);
  return { ...f, controls, setAir, oxygenAuthority, dry: () => { waterTop = 60; Object.assign(f.bot.entity, { isInWater: false }); setAir(300); }, ceiling: () => { ceiling = true; }, unload: () => { loaded = false; }, deepen: () => { waterTop = 75; } };
}

test('dry policy preserves exclusions and tightens plugin movement profiles', t => {
  const { bot } = fixture();
  const { Movements } = require('mineflayer-pathfinder');
  const m = new Movements(bot);
  const avoid = bot.registry.blocksByName.diamond_block.id;
  m.blocksToAvoid.add(avoid);
  const exclusion = () => 3;
  m.exclusionAreasStep.push(exclusion);
  constrainMovements(bot, m);
  constrainMovements(bot, m);
  t.true(m.blocksToAvoid.has(avoid));
  t.true(m.blocksToAvoid.has(bot.registry.blocksByName.water.id));
  t.is(m.exclusionAreasStep.filter((entry: unknown) => entry === exclusion).length, 1);
  t.false(m.canDig); t.false(m.canOpenDoors); t.false(m.allowFreeMotion);
  t.false(m.infiniteLiquidDropdownDistance); t.false(m.allowParkour);
  t.true(m.dontMineUnderFallingBlock); t.true(m.dontCreateFlow);
  t.is(m.maxDropDown, 2);
});

test('navigation refuses existing water/low oxygen without starting a path', async t => {
  const { bot } = fixture();
  let starts = 0;
  bot.pathfinder.goto = async () => { starts++; };
  await t.throwsAsync(moveAndVerify(bot, { isEnd: () => true } as never, 100), { message: /water|oxygen/i });
  t.is(starts, 0);
});

test('low oxygen cancels goto immediately and retains its lane until settlement', async t => {
  const f = fixture(); f.dry();
  let rejectPath: (error: Error) => void = () => {};
  let settlePath: () => void = () => {};
  const gate = new Promise<void>(resolve => { settlePath = resolve; });
  let stopped = false;
  f.bot.pathfinder.goto = () => new Promise<void>((_, reject) => { rejectPath = reject; }).finally(() => gate);
  f.bot.pathfinder.setGoal = () => { stopped = true; rejectPath(new Error('goal changed')); };
  let settled = false;
  const movement = moveAndVerify(f.bot, { isEnd: () => false } as never, 1000).finally(() => { settled = true; });
  const assertion = t.throwsAsync(movement, { message: /oxygen/i });
  await Promise.resolve();
  f.setAir(75);
  await new Promise(resolve => setImmediate(resolve));
  t.true(stopped); t.false(settled);
  settlePath(); await assertion;
  t.is(f.bot.listenerCount('breath'), 0);
});

test('explicit surfacing needs new breath evidence, always releases controls', async t => {
  const f = fixture();
  const action = surfaceFromWater(f.bot, { timeoutMs: 100 });
  t.true(f.controls.jump);
  f.bot.entity.position.y = 66;
  f.bot.emit('physicsTick');
  f.setAir(300);
  const result = await action;
  t.true(result.confirmed); t.false(f.controls.jump);
  t.false(result.dryLandConfirmed);
  t.is(f.bot.listenerCount('breath'), 0);
});

for (const otherAir of [300, 4680]) test(`another entity air ${otherAir} cannot confirm surfacing, even with an air head position`, async t => {
  const f = fixture(); const startRevision = f.oxygenAuthority.snapshot().revision;
  const action = surfaceFromWater(f.bot, { timeoutMs: 5 });
  f.bot.entity.position.y = 66;
  // Reproduce the pinned native cache write and unattributed event as well as
  // the raw other-entity packet; neither is own-player evidence.
  f.bot.oxygenLevel = Math.round(otherAir / 15); f.bot.emit('breath');
  f.setAir(otherAir, 42); f.bot.emit('physicsTick');
  const result = await action;
  t.false(result.confirmed); t.is(result.oxygen, 8);
  t.is(result.oxygenEvidence.revision, startRevision);
  t.false(f.controls.jump); t.is(f.oxygenAuthority.listenerCount('change'), 0);
});

test('own full-air sample before surfacing is not fresh confirmation', async t => {
  const f = fixture(); f.setAir(300);
  const before = f.oxygenAuthority.snapshot().revision;
  const action = surfaceFromWater(f.bot, { timeoutMs: 5 });
  f.bot.entity.position.y = 66; f.bot.emit('physicsTick'); f.bot.emit('breath');
  const result = await action;
  t.false(result.confirmed); t.is(result.oxygenEvidence.revision, before);
  t.is(result.oxygen, 20); t.false(f.controls.jump);
});

test('a fresh own full-air sample followed by own low-air correction cannot remain successful', async t => {
  const f = fixture(); const action = surfaceFromWater(f.bot, { timeoutMs: 30 });
  f.bot.entity.position.y = 66; f.setAir(300); f.setAir(75);
  const result = await action;
  t.false(result.confirmed); t.is(result.oxygen, 5); t.false(f.controls.jump);
});

test('surfacing rejects unknown, blocked and too-deep columns before control', async t => {
  for (const mode of ['blocked', 'unknown', 'deep'] as const) {
    const f = fixture(); if (mode === 'blocked') f.ceiling(); else if (mode === 'unknown') f.unload(); else f.deepen();
    await t.throwsAsync(surfaceFromWater(f.bot, { timeoutMs: 20 }), { message: /blocked|loaded|surface/i });
    t.falsy(f.controls.jump);
  }
});

test('surfacing timeout never treats local motion or stale oxygen as confirmation', async t => {
  const f = fixture();
  const action = surfaceFromWater(f.bot, { timeoutMs: 5 });
  f.bot.entity.position.y = 66; f.bot.oxygenLevel = 20; f.bot.emit('physicsTick');
  const result = await action;
  t.false(result.confirmed); t.false(f.controls.jump);
  t.is(f.bot.listenerCount('physicsTick'), 0);
});

test('surfacing cancellation releases controls and does not resume navigation', async t => {
  const f = fixture(); const controller = new AbortController();
  let goals = 0; f.bot.pathfinder.setGoal = () => { goals++; };
  const action = surfaceFromWater(f.bot, { signal: controller.signal, timeoutMs: 100 });
  const assertion = t.throwsAsync(action, { message: /cancel/i });
  controller.abort(); await assertion;
  t.false(f.controls.jump); t.is(goals, 1);
  t.is(f.bot.listenerCount('death'), 2, 'inventory and oxygen authorities keep their lifecycle listeners');
});

test('read-only safety inspection reports unknown oxygen and no unproven escape', t => {
  const bot = Object.assign(new EventEmitter(), { entity: { position: new Vec3(0, 64, 0) }, blockAt: () => null }) as unknown as Bot;
  const result = inspectMovementSafety(bot);
  t.is(result.oxygen, null); t.false(result.surfaceColumn.available);
  t.is(result.navigationPolicy, 'dry_land_only');
});

test('bounded dynamic navigation detects new water and removes its listeners', async t => {
  const f = fixture(); f.dry();
  const wait = waitForDryMovement(f.bot, 1000);
  const assertion = t.throwsAsync(wait, { message: /Water detected/ });
  Object.assign(f.bot.entity, { isInWater: true }); f.bot.emit('physicsTick');
  await assertion;
  t.is(f.bot.listenerCount('breath'), 0); t.is(f.bot.listenerCount('physicsTick'), 0);
});

test('navigation abort before goto starts never issues a delayed goal', async t => {
  const f = fixture(); f.dry(); const controller = new AbortController();
  let starts = 0; f.bot.pathfinder.goto = async () => { starts++; };
  const action = moveAndVerify(f.bot, { isEnd: () => true } as never, 500, { signal: controller.signal });
  const assertion = t.throwsAsync(action);
  controller.abort(); await assertion;
  t.is(starts, 0); t.is(f.bot.listenerCount('physicsTick'), 0);
});

test('legacy move-to-position propagates its action cancellation before a deferred path starts', async t => {
  const f = fixture(); f.dry(); const controller = new AbortController();
  let starts = 0; f.bot.pathfinder.goto = async () => { starts++; };
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const factory = new ToolFactory(server, { checkConnectionAndReconnect: async () => ({ connected: true }) } as unknown as BotConnection);
  registerPositionTools(factory, () => f.bot, () => ({ signal: controller.signal }));
  controller.abort();
  const handler = (server.tool as sinon.SinonStub).getCalls().find(call => call.args[0] === 'move-to-position')!.args[3];
  const result = await handler({ x: 2, y: 64, z: 0 });
  t.true(result.isError); t.is(starts, 0);
});

test.serial('MCP native goto keeps the shared lane occupied through stop until its real path settles', async t => {
  const f = fixture(); f.dry(); Object.assign(f.bot, { entities: {}, players: {} });
  f.bot.pathfinder.stop = () => {};
  let rejectPath: (error: Error) => void = () => {};
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let starts = 0;
  f.bot.pathfinder.goto = () => { starts++; return new Promise<void>((_, reject) => { rejectPath = reject; }).finally(() => gate); };
  f.bot.pathfinder.setGoal = () => { rejectPath(new Error('goal changed')); };
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const reads = new Set<string>();
  const factory = new ToolFactory(server, {
    checkConnectionAndReconnect: async () => ({ connected: true }),
    assertActionAllowed: (name: string) => { if (!reads.has(name)) f.authority.assertMutationReady(); }
  } as unknown as BotConnection);
  const complete = await registerCompleteControls({ server, factory, bot: f.bot, fixture: true, legacy: new Map(), markRead: name => reads.add(name), stateRoot: '/tmp/movement-safety-fixture' });
  t.teardown(async () => { release(); await complete.stop(); f.bot.emit('end', 'neutral test'); });
  const invoke = (name: string, args = {}) => (server.tool as sinon.SinonStub).getCalls().find(call => call.args[0] === name)!.args[3](args);
  t.true(reads.has('inspect-movement-safety'));
  for (const name of ['inspect-movement-safety', 'surface-from-water', 'launch-boat']) t.true(complete.names.includes(name));
  let laterStarted = false;
  factory.registerTool('later-test', '', {}, async () => { laterStarted = true; return factory.createResponse('later'); });
  const first = invoke('goto', { goalType: 'block', x: 2, y: 64, z: 0, timeout: 1000 });
  const second = invoke('later-test');
  await new Promise(resolve => setImmediate(resolve));
  t.is(starts, 1);
  await complete.stop(); await new Promise(resolve => setImmediate(resolve));
  t.false(laterStarted);
  release(); t.true((await first).isError); await second; t.true(laterStarted);
  f.authority.block('neutral fixture fence');
  const read = await invoke('inspect-movement-safety'); t.not(read.isError, true);
  t.is(f.authority.fence, 'neutral fixture fence');
});
