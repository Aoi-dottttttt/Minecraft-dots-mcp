import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { Vec3 } from 'vec3';
import type { Block } from 'prismarine-block';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import { ToolFactory } from '../src/tool-factory.js';
import { registerBlockTools } from '../src/tools/block-tools.js';
import { installPlacementProvenance } from '../src/placement-provenance.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCompleteControls } from '../src/complete-controls.js';
import { inventoryFixture } from './helpers/inventory-fixture.js';

const require = createRequire(import.meta.url);
const faces = {
  down: new Vec3(0, -1, 0), up: new Vec3(0, 1, 0),
  north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1),
  east: new Vec3(1, 0, 0), west: new Vec3(-1, 0, 0)
};

type Packet = { name: string; data: Record<string, unknown> };
function fixture(faceDirection: keyof typeof faces = 'down') {
  const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const now = sinon.stub(performance, 'now').callsFake(() => clock.now);
  const s = inventoryFixture([{ name: 'furnace', count: 3, slot: 36 }]);
  const { bot } = s;
  const BlockType = require('prismarine-block')(bot.registry);
  const target = new Vec3(2, 64, 2);
  const referencePos = target.plus(faces[faceDirection]);
  const face = faces[faceDirection].scaled(-1);
  const facePoint = referencePos.offset(0.5, 0.5, 0.5).plus(face.scaled(0.5));
  const blocks = new Map<string, Block>();
  const makeBlock = (name: string, position: Vec3) => {
    const block = BlockType.fromStateId(bot.registry.blocksByName[name].minStateId, 0) as Block;
    block.position = position.clone();
    return block;
  };
  const reference = makeBlock('stone', referencePos);
  blocks.set(referencePos.toString(), reference);
  Object.assign(bot, {
    entity: { position: new Vec3(0.5, 62.38, 0.5), velocity: new Vec3(0, 0, 0),
      yaw: 0, pitch: 0, eyeHeight: 1.62, height: 1.8, effects: {}, attributes: {} },
    game: { dimension: 'overworld', gameMode: 'survival' }, health: 20, isAlive: true,
    supportFeature: (name: Parameters<typeof bot.registry.supportFeature>[0]) => bot.registry.supportFeature(name),
    blockAt: (position: Vec3) => blocks.get(position.toString()) ?? makeBlock('air', position),
    canSeeBlock: () => true,
    swingArm: () => {}
  });
  Object.defineProperty(bot, 'heldItem', { get: () => s.authority.getFrame(0).slots[36] });
  Object.assign(bot._client, { state: 'play' });
  const packets: Packet[] = [];
  const mode = { reply: 'confirmed' as 'confirmed' | 'optimistic' | 'refused' | 'no-debit' };
  bot._client.write = (name: string, data: Record<string, unknown>) => {
    packets.push({ name, data: structuredClone(data) });
    if (name !== 'block_place') return;
    setTimeout(() => {
      const old = bot.blockAt(target);
      const placed = makeBlock(mode.reply === 'refused' ? 'air' : 'furnace', target);
      blocks.set(target.toString(), placed);
      if (mode.reply !== 'optimistic') bot._client.emit('block_change', { location: target, type: placed.stateId });
      (bot as unknown as EventEmitter).emit(`blockUpdate:${referencePos}`, reference, reference);
      (bot as unknown as EventEmitter).emit(`blockUpdate:${target}`, old, placed);
      if (mode.reply !== 'no-debit' && mode.reply !== 'refused') {
        s.slots[36] = { ...s.slots[36], count: 2 };
        s.sync();
      }
    }, 0);
  };
  require('mineflayer/lib/plugins/physics.js')(bot, {});
  require('mineflayer/lib/plugins/generic_place.js')(bot);
  require('mineflayer/lib/plugins/place_block.js')(bot);
  // Keep the genuine physics scheduler, rotation writes and public placement.
  // Neutralize motion only; no network client or game server is created.
  (bot.physics as unknown as { simulatePlayer: () => { apply: () => void } }).simulatePlayer = () => ({ apply: () => {} });
  const ledger = installPlacementProvenance(bot);
  const controller = new AbortController();
  let currentBot = bot;
  const server = { tool: sinon.stub() };
  const factory = new ToolFactory(server as unknown as McpServer, {
    checkConnectionAndReconnect: async () => ({ connected: true })
  } as BotConnection);
  registerBlockTools(factory, () => currentBot, () => ({ signal: controller.signal }));
  const handler = server.tool.getCalls().find(call => call.args[0] === 'place-block')!.args[3];
  const run = () => handler({ ...target, faceDirection });
  bot.emit('login');
  bot._client.emit('position', { x: 0.5, y: 62.38, z: 0.5, yaw: 0, pitch: 0, flags: 0, teleportId: 1 });
  packets.length = 0;
  return { ...s, target, reference, referencePos, face, facePoint, blocks, makeBlock, packets, mode,
    clock, ledger, controller, factory, run, replaceBot: () => { currentBot = { ...bot } as typeof bot; },
    cleanup: () => { bot.emit('end', 'offline fixture ended'); clock.restore(); now.restore(); }
  };
}

for (const faceDirection of Object.keys(faces) as Array<keyof typeof faces>) {
  test.serial(`pinned Mineflayer sends clicked ${faceDirection} face rotation before native block_place`, async t => {
    const s = fixture(faceDirection); t.teardown(s.cleanup);
    t.is(require('mineflayer/package.json').version, '4.39.0');
    const lookAt = sinon.spy(s.bot, 'lookAt');
    const result = s.run();
    await s.clock.tickAsync(100);
    const outcome = await result;
    t.falsy(outcome.isError, outcome.content[0].text);
    t.deepEqual(lookAt.firstCall.args, [s.facePoint, true], 'preparation aims at exactly the point used by placeBlock');
    t.deepEqual(lookAt.secondCall.args[0], s.facePoint, 'public placeBlock retains its own unchanged look');
    const placement = s.packets.findIndex(packet => packet.name === 'block_place');
    const rotations = s.packets.slice(0, placement).filter(packet => ['look', 'position_look'].includes(packet.name));
    t.true(rotations.length > 0, 'a genuine physics rotation precedes placement');
    const rotation = rotations.at(-1)!;
    t.is(rotation.data.yaw, Math.fround((Math.PI - s.bot.entity.yaw) * 180 / Math.PI));
    t.is(rotation.data.pitch, Math.fround(-s.bot.entity.pitch * 180 / Math.PI));
    t.is(s.packets.filter(packet => packet.name === 'block_place').length, 1);
    t.true(s.ledger.has(s.target), 'the native call still requires raw block and exact inventory debit evidence');
  });
}

test.serial('pinned public placeBlock reproduces stale rotation without the tick barrier', async t => {
  const s = fixture(); t.teardown(s.cleanup);
  await s.bot.lookAt(s.facePoint, true);
  const result = s.bot.placeBlock(s.reference, s.face);
  await s.clock.tickAsync(1);
  await result;
  t.deepEqual(s.packets.map(packet => packet.name), ['block_place']);
});

test.serial('stalled pinned physics times out, keeps the action lane, and never places on later ticks', async t => {
  const s = fixture(); t.teardown(s.cleanup);
  Object.assign(s.bot._client, { state: 'configuration' });
  const result = s.run();
  const later = sinon.stub().resolves();
  const queued = s.factory.runInActionLane(later);
  await s.clock.tickAsync(5049);
  t.true(later.notCalled);
  await s.clock.tickAsync(1);
  const outcome = await result;
  t.true(outcome.isError);
  t.regex(outcome.content[0].text, /Timeout waiting for 1 ticks after 5050ms/);
  await queued;
  t.true(later.calledOnce);
  t.is(s.bot.listenerCount('physicsTick'), 0);
  Object.assign(s.bot._client, { state: 'play' });
  await s.clock.tickAsync(100);
  t.false(s.packets.some(packet => packet.name === 'block_place'));
  t.false(s.ledger.has(s.target));
});

const staleChanges = {
  cancellation: (s: ReturnType<typeof fixture>) => s.controller.abort(),
  session: (s: ReturnType<typeof fixture>) => s.replaceBot(),
  transfer: (s: ReturnType<typeof fixture>) => s.bot._client.emit('start_configuration'),
  protocol: (s: ReturnType<typeof fixture>) => { Object.assign(s.bot._client, { state: 'configuration' }); },
  dead: (s: ReturnType<typeof fixture>) => { s.bot.health = 0; },
  entity: (s: ReturnType<typeof fixture>) => { s.bot.entity = { ...s.bot.entity } as typeof s.bot.entity; },
  height: (s: ReturnType<typeof fixture>) => { s.bot.entity.height = 1.5; },
  hotbar: (s: ReturnType<typeof fixture>) => { s.bot.quickBarSlot = 1; },
  referenceUnload: (s: ReturnType<typeof fixture>) => { s.bot.blockAt = () => null; },
  disconnect: (s: ReturnType<typeof fixture>) => s.bot.emit('end', 'synthetic disconnect'),
  respawn: (s: ReturnType<typeof fixture>) => s.bot.emit('respawn'),
  dimension: (s: ReturnType<typeof fixture>) => { s.bot.game.dimension = 'the_nether'; },
  held: (s: ReturnType<typeof fixture>) => { s.authority.getFrame(0).slots[36]!.type++; },
  count: (s: ReturnType<typeof fixture>) => { s.authority.getFrame(0).slots[36]!.count--; },
  window: (s: ReturnType<typeof fixture>) => { Object.assign(s.bot, { currentWindow: { id: 1 } }); },
  reference: (s: ReturnType<typeof fixture>) => { s.reference.stateId++; },
  target: (s: ReturnType<typeof fixture>) => { s.blocks.set(s.target.toString(), s.makeBlock('stone', s.target)); },
  player: (s: ReturnType<typeof fixture>) => { s.bot.entity.position.set(s.target.x, s.target.y, s.target.z); },
  reach: (s: ReturnType<typeof fixture>) => { s.bot.entity.position.x = -20; },
  movement: (s: ReturnType<typeof fixture>) => { s.bot.entity.position.x += 0.1; },
  eyeHeight: (s: ReturnType<typeof fixture>) => { Object.assign(s.bot.entity, { eyeHeight: 1.27 }); },
  rotation: (s: ReturnType<typeof fixture>) => { s.bot.entity.yaw += 0.1; },
  visibility: (s: ReturnType<typeof fixture>) => { s.bot.canSeeBlock = () => false; }
};
for (const [name, change] of Object.entries(staleChanges)) {
  test.serial(`placement refuses ${name} during pinned rotation tick without a block packet or provenance`, async t => {
    const s = fixture(); t.teardown(s.cleanup);
    s.bot.once('physicsTick', () => { change(s); });
    const result = s.run();
    await s.clock.tickAsync(100);
    const outcome = await result;
    t.true(outcome.isError, outcome.content[0].text);
    t.false(s.packets.some(packet => packet.name === 'block_place'));
    t.false(s.ledger.has(s.target));
    t.is(s.ledger.listenerCount('block'), 0);
    t.is(s.bot.listenerCount('physicsTick'), 0);
  });
}

for (const reply of ['optimistic', 'refused', 'no-debit'] as const) {
  test.serial(`rotation repair retains ${reply} confirmation boundary without retry`, async t => {
    const s = fixture(); t.teardown(s.cleanup);
    s.mode.reply = reply;
    const result = s.run();
    await s.clock.tickAsync(3200);
    const outcome = await result;
    if (reply !== 'no-debit') t.true(outcome.isError);
    t.is(s.packets.filter(packet => packet.name === 'block_place').length, 1);
    t.false(s.ledger.has(s.target));
    t.is(s.ledger.listenerCount('block'), 0);
    t.is(s.authority.listenerCount('change'), 0);
  });
}

for (const history of ['pending-look', 'already-sent', 'out-of-range-pitch'] as const) {
  test.serial(`pinned placement synchronizes a zero-change forced aim after ${history}`, async t => {
    const s = fixture(); t.teardown(s.cleanup);
    if (history === 'out-of-range-pitch') {
      // Public look accepts this value; a prior plugin must not leave a partial
      // server pitch that can slip past a same-point local rotation check.
      await s.bot.look(0, 10 * Math.PI, true);
      await s.clock.tickAsync(100);
    }
    const pending = s.bot.lookAt(s.facePoint, history === 'already-sent');
    if (history === 'already-sent') { await pending; await s.clock.tickAsync(100); }
    const look = sinon.spy(s.bot, 'look');
    const packetCount = s.packets.length;
    const result = s.run();
    await s.clock.tickAsync(0);
    t.is(s.packets.length, packetCount, 'the forced public turns write no intermediate packet before physics');
    t.is(look.getCalls().filter(call => call.args[2] === true).length, 3, 'only zero-change aim uses the public turn workaround');
    await s.clock.tickAsync(100);
    const outcome = await result;
    await pending;
    t.falsy(outcome.isError, outcome.content[0].text);
    const placement = s.packets.findIndex(packet => packet.name === 'block_place');
    const rotation = s.packets.slice(0, placement).filter(packet => ['look', 'position_look'].includes(packet.name)).at(-1)!;
    const degrees = (Math.PI - s.bot.entity.yaw) * 180 / Math.PI;
    const yawError = ((Number(rotation.data.yaw) - degrees + 540) % 360 + 360) % 360 - 180;
    t.true(Math.abs(yawError) < 0.001, 'last sent yaw must match clicked-face yaw, modulo a full turn');
    t.true(Math.abs(Number(rotation.data.pitch) + s.bot.entity.pitch * 180 / Math.PI) < 0.001,
      'last sent pitch must match clicked-face pitch');
    t.is(s.packets.filter(packet => packet.name === 'block_place').length, 1);
    t.true(s.ledger.has(s.target));
  });
}


for (const pose of [{ yaw: 1e20, pitch: 0 }, { yaw: 0, pitch: 1e20 }, { yaw: NaN, pitch: 0 }, { yaw: 0, pitch: NaN }]) {
  test.serial(`non-finite or extreme starting rotation ${pose.yaw}/${pose.pitch} cannot place`, async t => {
    const s = fixture(); t.teardown(s.cleanup);
    Object.assign(s.bot.entity, pose);
    const result = s.run();
    await s.clock.tickAsync(100);
    t.true((await result).isError);
    t.false(s.packets.some(packet => packet.name === 'block_place'));
    t.false(s.ledger.has(s.target));
  });
}

for (const fault of ['cancel-nudge', 'ineffective-nudge', 'ineffective-restore'] as const) {
  test.serial(`zero-change rotation workaround refuses ${fault} without later placement`, async t => {
    const s = fixture(); t.teardown(s.cleanup);
    const pending = s.bot.lookAt(s.facePoint);
    const originalLook = s.bot.look.bind(s.bot);
    let forcedCalls = 0;
    s.bot.look = async (yaw, pitch, force) => {
      if (force) forcedCalls++;
      if ((fault === 'ineffective-nudge' && forcedCalls === 2) ||
        (fault === 'ineffective-restore' && forcedCalls === 3)) return;
      await originalLook(yaw, pitch, force);
      if (fault === 'cancel-nudge' && forcedCalls === 2) s.controller.abort();
    };
    const result = s.run();
    await s.clock.tickAsync(100);
    t.true((await result).isError);
    await pending;
    t.false(s.packets.some(packet => packet.name === 'block_place'));
    t.false(s.ledger.has(s.target));
    t.is(forcedCalls, fault === 'ineffective-restore' ? 3 : 2, 'cancellation never initiates a cleanup look');
  });
}

for (const damageTiming of ['preparation', 'submitted'] as const) {
  test.serial(`V2 defense requested during placement ${damageTiming} respects the submission boundary`, async t => {
    const s = fixture();
    const root = await mkdtemp(join(tmpdir(), 'placement-defense-fixture-'));
    Object.assign(s.bot, { entities: {} });
    Object.assign(s.bot.entity, { id: 1 });
    const complete = await registerCompleteControls({ bot: s.bot, server: { tool() {} }, factory: s.factory,
      fixture: true, markRead() {}, legacy: new Map(), stateRoot: root });
    t.teardown(async () => { complete.selfDefense.dispose(); s.cleanup(); await rm(root, { recursive: true, force: true }); });
    complete.selfDefense.enable();
    const handlers = new Map<string, (args: object) => Promise<unknown>>();
    const legacyFactory = {
      registerTool(name: string, _description: string, _schema: object, handler: (args: object) => Promise<unknown>) { handlers.set(name, handler); },
      createResponse: s.factory.createResponse.bind(s.factory),
      createErrorResponse: s.factory.createErrorResponse.bind(s.factory)
    } as unknown as ToolFactory;
    registerBlockTools(legacyFactory, () => s.bot, complete.getOptions);
    const damage = () => { s.bot._client.emit('damage_event', { entityId: 1, sourceCauseId: 0, sourceDirectId: 0 }); };
    if (damageTiming === 'preparation') s.bot.once('physicsTick', damage);
    else {
      const write = s.bot._client.write.bind(s.bot._client);
      s.bot._client.write = (name, data) => { write(name, data); if (name === 'block_place') damage(); };
    }
    let signal: AbortSignal | undefined;
    const task = s.factory.runInActionLane(() => complete.runAction(async () => {
      signal = complete.getOptions().signal;
      return handlers.get('place-block')!({ ...s.target, faceDirection: 'down' });
    }, 'place-block')).catch(error => error as Error);
    await s.clock.tickAsync(100);
    const result = await task;
    t.true(result instanceof Error);
    t.regex((result as Error).message, /self-defense/);
    if (damageTiming === 'submitted') t.false(signal!.aborted, 'defense does not abort a critical submitted operation');
    const expected = damageTiming === 'preparation' ? 0 : 1;
    t.is(s.packets.filter(packet => packet.name === 'block_place').length, expected);
    t.is(s.ledger.has(s.target), damageTiming === 'submitted');
    t.is(s.authority.fence, null);
    await s.clock.tickAsync(100);
    t.is(s.packets.filter(packet => packet.name === 'block_place').length, expected, 'no delayed placement or replay');
  });
}
