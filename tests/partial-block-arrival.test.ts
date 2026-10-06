import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import type mineflayer from 'mineflayer';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import { ToolFactory } from '../src/tool-factory.js';
import { registerPositionTools } from '../src/tools/position-tools.js';

const require = createRequire(import.meta.url);
const Block = require('prismarine-block')('1.21.1');
const data = minecraftData('1.21.1');
const pathfinder = require('mineflayer-pathfinder');

function setup(bot: unknown) {
  const server = { tool: sinon.stub() };
  const factory = new ToolFactory(server as unknown as McpServer, {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection);
  registerPositionTools(factory, () => bot as mineflayer.Bot);
  return (args: object) => server.tool.getCalls().find(call => call.args[0] === 'move-to-position')!.args[3](args);
}

function fixture(name = 'farmland', position = new Vec3(10.5, 20.9375, 30.5), properties?: object) {
  const block = properties ? Block.fromProperties(data.blocksByName[name].id, properties, 0)
    : Block.fromStateId(data.blocksByName[name].defaultState, 0);
  block.position = position.floored();
  const bot = Object.assign(new EventEmitter(), {
    entity: { position, onGround: true, velocity: new Vec3(0, 0, 0) },
    blockAt: sinon.stub().returns(block),
    pathfinder: {
      goto: sinon.stub().resolves(), setGoal: sinon.stub(),
      movements: { emptyBlocks: new Set([data.blocksByName.air.id]) }
    },
    clearControlStates: sinon.stub()
  });
  const target = { x: Math.floor(position.x) + 0.5, y: 21, z: Math.floor(position.z) + 0.5, range: 0.35 };
  return { bot, block, target, execute: setup(bot) };
}

for (const range of [0, 0.3, 0.35, 0.99]) {
  test(`empty-path farmland accepts the supported planning cell at range ${range}`, async t => {
    const f = fixture();
    const result = await f.execute({ ...f.target, range });
    t.falsy(result.isError);
    t.true(f.bot.pathfinder.goto.calledOnce);
    t.true(f.bot.pathfinder.setGoal.notCalled);
    t.is(f.bot.listenerCount('goal_reached'), 0);
    t.is(f.bot.pathfinder.goto.firstCall.args[0].y, 21);
  });
}

test('real pinned pathfinder returns empty success without goal_reached for repeated farmland target', async t => {
  const f = fixture();
  const bot = Object.assign(f.bot, {
    registry: data, inventory: { items: () => [] }, entities: {}, game: { minY: -64 },
    controlState: {}, physics: {},
  });
  pathfinder.pathfinder(bot);
  const reached = sinon.spy();
  const updated = sinon.spy();
  bot.on('goal_reached', reached);
  bot.on('path_update', updated);
  const pending = setup(bot)({ ...f.target, timeoutMs: 1000 });
  await new Promise<void>(resolve => setImmediate(resolve));
  // The actual plugin's monitor computes the A* start at y21 from feet y20.9375.
  bot.emit('physicsTick');
  const result = await pending;
  t.falsy(result.isError);
  t.true(updated.calledOnce);
  t.is(updated.firstCall.args[0].status, 'success');
  t.deepEqual(updated.firstCall.args[0].path, []);
  t.true(reached.notCalled);
  t.is((bot.pathfinder as unknown as { goal: unknown }).goal, null);
  bot.emit('physicsTick');
  t.true(updated.calledOnce);
});

test('bottom slab accepts its collision-supported raised planning cell', async t => {
  const f = fixture('stone_slab', new Vec3(10.5, 20.5, 30.5), { type: 'bottom', waterlogged: false });
  t.falsy((await f.execute(f.target)).isError);
});

test('lower stair tread accepts support without intersecting the upper riser', async t => {
  const f = fixture('oak_stairs', new Vec3(10.1, 20.5, 30.5), { half: 'bottom', facing: 'east', shape: 'straight', waterlogged: false });
  t.falsy((await f.execute(f.target)).isError);
});

const failures: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  ['airborne', f => { f.bot.entity.onGround = false; }],
  ['unknown ground state', f => { f.bot.entity.onGround = undefined as unknown as boolean; }],
  ['missing block', f => { f.bot.blockAt.returns(null); }],
  ['air even with stale shapes', f => { f.block.type = data.blocksByName.air.id; }],
  ['empty shapes', f => { f.block.shapes = []; }],
  ['missing empty-block classification', f => { f.bot.pathfinder.movements.emptyBlocks = undefined as unknown as Set<number>; }],
  ['feet above surface', f => { f.bot.entity.position.y += 0.001; }],
  ['feet inside surface', f => { f.bot.entity.position.y -= 0.001; }],
  ['wrong block position', f => { f.block.position = f.block.position.offset(1, 0, 0); }],
  ['integer feet below requested planning cell', f => { f.bot.entity.position.y = 20; }],
  ['wrong goal x', f => { f.target.x += 1; }],
  ['wrong goal z', f => { f.target.z -= 1; }],
  ['wrong raised goal y', f => { f.target.y += 1; }],
  ['malformed collision shape', f => { f.block.shapes = [[0, 0, 0, 1, Number.NaN, 1]]; }],
  ['sparse collision shape', f => { const shape = [0, 0, 0, 1, 0.9375, 1]; delete shape[1]; f.block.shapes = [shape]; }],
  ['null collision shape', f => { f.block.shapes = [null as unknown as number[]]; }],
  ['disjoint support', f => { f.bot.entity.position.x = 10.1; f.block.shapes = [[0.5, 0, 0, 1, 0.9375, 1]]; }],
  ['tangent-only support', f => { f.bot.entity.position.x = 10.2; f.block.shapes = [[0.5, 0, 0, 1, 0.9375, 1]]; }],
];
for (const [name, mutate] of failures) {
  test(`empty-path support fallback rejects ${name}`, async t => {
    const f = fixture();
    mutate(f);
    const result = await f.execute(f.target);
    t.true(result.isError);
    t.true(result.content[0].text.includes('without reaching the requested goal'));
    t.is(f.bot.listenerCount('goal_reached'), 0);
  });
}

test('positive partial footprint overlap is enough for grounded edge support', async t => {
  const f = fixture();
  f.bot.entity.position.x = 10.201;
  f.block.shapes = [[0.5, 0, 0, 1, 0.9375, 1]];
  t.falsy((await f.execute(f.target)).isError);
});

test('lower stair position intersecting upper riser remains rejected', async t => {
  const f = fixture('oak_stairs', new Vec3(10.5, 20.5, 30.5), { half: 'bottom', facing: 'east', shape: 'straight', waterlogged: false });
  t.true((await f.execute(f.target)).isError);
});

test('GoalNear continues to floor decimal goals and use an integer-grid radius', async t => {
  const f = fixture();
  const goal = new pathfinder.goals.GoalNear(f.target.x, 20.9375, f.target.z, 0.35);
  t.is(goal.y, 20);
  t.false(goal.isEnd(f.bot.entity.position.floored().offset(0, 1, 0)));
  t.true(goal.isEnd(f.bot.entity.position.floored()));
  const result = await f.execute({ ...f.target, x: f.target.x + 1, range: 1 });
  t.falsy(result.isError);
  t.is(f.bot.pathfinder.goto.firstCall.args[0].rangeSq, 1);
});

test('support fallback cannot clear a newer goal owned by another operation', async t => {
  const f = fixture();
  const newerGoal = new pathfinder.goals.GoalNear(99, 99, 99, 0);
  Object.assign(f.bot.pathfinder, { goal: newerGoal });
  t.falsy((await f.execute(f.target)).isError);
  t.true(f.bot.pathfinder.setGoal.notCalled);
  t.true(f.bot.clearControlStates.notCalled);
});
