// Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Bot } from 'mineflayer';
import type { BotConnection } from '../src/bot-connection.js';
import { ToolFactory } from '../src/tool-factory.js';
import { registerPositionTools } from '../src/tools/position-tools.js';
import { registerBlockTools } from '../src/tools/block-tools.js';

function harness(bot: unknown = {}) {
  const server = { tool: sinon.stub() };
  const connection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }),
    assertActionAllowed: sinon.stub()
  };
  const factory = new ToolFactory(server as unknown as McpServer, connection as unknown as BotConnection);
  const invoke = (name: string, args = {}) => {
    const tool = server.tool.getCalls().find(call => call.args[0] === name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return tool.args[3](args);
  };
  return { factory, connection, invoke, getBot: () => bot as Bot };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('all tool actions serialize and a rejected executor does not poison the queue', async t => {
  const h = harness();
  const gate = deferred();
  const order: string[] = [];
  h.factory.registerTool('first', '', {}, async () => { order.push('first-start'); await gate.promise; order.push('first-end'); throw new Error('rejected click'); });
  h.factory.registerTool('second', '', {}, async () => { order.push('second'); return h.factory.createResponse('done'); });
  const first = h.invoke('first');
  const second = h.invoke('second');
  await new Promise(resolve => setImmediate(resolve));
  t.deepEqual(order, ['first-start']);
  t.is(h.connection.checkConnectionAndReconnect.callCount, 1);
  gate.resolve();
  t.true((await first).isError);
  t.falsy((await second).isError);
  t.deepEqual(order, ['first-start', 'first-end', 'second']);
});

test('an uncertainty fence blocks execution and preserves an error response', async t => {
  const h = harness();
  const executor = sinon.stub().resolves(h.factory.createResponse('unsafe'));
  h.connection.assertActionAllowed.throws(new Error('Inventory state uncertain'));
  h.factory.registerTool('craft-item', '', {}, executor);
  const result = await h.invoke('craft-item');
  t.true(result.isError);
  t.true(result.content[0].text.includes('Inventory state uncertain'));
  t.true(executor.notCalled);
});

test('a resolved path with no arrival does not report movement success', async t => {
  const bot = { entity: { position: new Vec3(0, 64, 0) }, pathfinder: { goto: sinon.stub().resolves(), setGoal: sinon.stub() }, clearControlStates: sinon.stub() };
  const h = harness(bot);
  registerPositionTools(h.factory, h.getBot);
  const result = await h.invoke('move-to-position', { x: 20, y: 64, z: 20 });
  t.true(result.isError);
  t.true(result.content[0].text.includes('not confirmed'));
  t.true(bot.pathfinder.setGoal.calledOnceWith(null));
});

test.serial('timeout keeps lane occupied until underlying movement actually settles', async t => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const movement = deferred();
  const bot = { pathfinder: { goto: sinon.stub().returns(movement.promise), setGoal: sinon.stub() }, clearControlStates: sinon.stub() };
  const h = harness(bot);
  registerPositionTools(h.factory, h.getBot);
  const later = sinon.stub().resolves(h.factory.createResponse('later'));
  h.factory.registerTool('later', '', {}, later);
  const first = h.invoke('move-to-position', { x: 20, y: 64, z: 20, timeoutMs: 100 });
  const second = h.invoke('later');
  await clock.tickAsync(100);
  t.true(bot.pathfinder.setGoal.calledOnceWith(null));
  t.true(later.notCalled);
  movement.reject(new Error('goal changed'));
  t.true((await first).isError);
  await second;
  t.true(later.calledOnce);
});

test('movement rejects invalid ranges and excessive control durations before side effects', async t => {
  const bot = { pathfinder: { goto: sinon.stub() }, setControlState: sinon.stub() };
  const h = harness(bot);
  registerPositionTools(h.factory, h.getBot);
  for (const range of [-1, Infinity, 65]) {
    t.true((await h.invoke('move-to-position', { x: 0, y: 64, z: 0, range })).isError);
  }
  for (const duration of [-1, 0, 2001, Infinity, 1.5]) {
    t.true((await h.invoke('move-in-direction', { direction: 'forward', duration })).isError);
  }
  t.true(bot.pathfinder.goto.notCalled);
  t.true(bot.setControlState.notCalled);
});

test.serial('jump keeps serialization until control release', async t => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const bot = { setControlState: sinon.stub() };
  const h = harness(bot);
  registerPositionTools(h.factory, h.getBot);
  const later = sinon.stub().resolves(h.factory.createResponse('later'));
  h.factory.registerTool('later', '', {}, later);
  const jump = h.invoke('jump');
  const next = h.invoke('later');
  await clock.tickAsync(249);
  t.true(later.notCalled);
  t.true(bot.setControlState.calledOnceWith('jump', true));
  await clock.tickAsync(1);
  await jump;
  await next;
  t.true(bot.setControlState.calledWith('jump', false));
  t.true(later.calledOnce);
});

function placementBot() {
  let targetType = 0;
  const target = new Vec3(2, 64, 0);
  const bot = Object.assign(new EventEmitter(), {
    _client: new EventEmitter(),
    registry: minecraftData('1.21.1'),
    version: '1.21.1',
    entity: { position: new Vec3(0, 64, 0) },
    heldItem: { name: 'stone', type: 1 },
    blockAt: sinon.stub().callsFake((p: Vec3) => p.equals(target)
      ? { name: targetType ? 'stone' : 'air', type: targetType, position: p }
      : { name: 'stone', type: 1, position: p }),
    canSeeBlock: sinon.stub().returns(true),
    lookAt: sinon.stub().resolves(),
    placeBlock: sinon.stub().resolves()
  });
  return { bot, setTarget: (type: number) => { targetType = type; } };
}

test('placement no-op is an error and does not issue repeated placement attempts', async t => {
  const { bot } = placementBot();
  const h = harness(bot);
  registerBlockTools(h.factory, h.getBot);
  const result = await h.invoke('place-block', { x: 2, y: 64, z: 0 });
  t.true(result.isError);
  t.true(bot.placeBlock.calledOnce);
});

test('placement rejection is not retried even if a late block update arrives', async t => {
  const { bot, setTarget } = placementBot();
  bot.placeBlock.callsFake(async () => { setTarget(1); throw new Error('late timeout'); });
  const h = harness(bot);
  registerBlockTools(h.factory, h.getBot);
  const result = await h.invoke('place-block', { x: 2, y: 64, z: 0 });
  t.true(result.isError);
  t.true(bot.placeBlock.calledOnce);
});

test('placement success requires the expected block at the target', async t => {
  const { bot, setTarget } = placementBot();
  bot.placeBlock.callsFake(async () => { setTarget(1); bot._client.emit('block_change', { location: new Vec3(2, 64, 0), type: bot.registry.blocksByName.stone.minStateId }); });
  const h = harness(bot);
  registerBlockTools(h.factory, h.getBot);
  const result = await h.invoke('place-block', { x: 2, y: 64, z: 0 });
  t.falsy(result.isError);
  t.true(result.content[0].text.includes('Placed stone'));
});

test('dig resolution without target removal is not reported as success', async t => {
  const bot = Object.assign(new EventEmitter(), {
    _client: new EventEmitter(),
    registry: minecraftData('1.21.1'),
    blockAt: sinon.stub().returns({ name: 'stone', type: 1 }),
    canDigBlock: sinon.stub().returns(true), canSeeBlock: sinon.stub().returns(true),
    dig: sinon.stub().resolves()
  });
  const h = harness(bot);
  registerBlockTools(h.factory, h.getBot);
  const result = await h.invoke('dig-block', { x: 2, y: 64, z: 0 });
  t.true(result.isError);
  t.true(result.content[0].text.includes('not confirmed'));
});
