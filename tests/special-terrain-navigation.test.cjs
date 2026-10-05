// Locked upstream A*/collision fixtures only. No Minecraft connection or live
// ladder, water, threshold or boat acceptance is implied by these tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Physics, PlayerState } = require('prismarine-physics');
const data = require('minecraft-data')('1.21.1');
const Block = require('prismarine-block')(data);
const safety = import('../dist/movement-safety.js');

function fixture(terrain) {
  const bot = new EventEmitter();
  bot.version = '1.21.1'; bot.registry = data; bot.entities = {}; bot.game = { minY: -64 };
  bot.oxygenLevel = 20; bot.health = 20;
  bot.controlState = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  bot.entity = { position: new Vec3(-2.5, 65, 0.5), velocity: new Vec3(0, 0, 0), onGround: true,
    yaw: 0, pitch: 0, effects: {}, attributes: {}, height: 1.8, width: 0.6 };
  bot.jumpTicks = 0; bot.jumpQueued = false; bot.fireworkRocketDuration = 0;
  bot.inventory = { items: () => [], slots: [] };
  bot.blockAt = point => {
    const p = point.floored();
    const spec = terrain(p);
    if (!spec) return null;
    const block = Block.fromProperties(spec[0], spec[1] ?? {}, 0); block.position = p; return block;
  };
  bot.setControlState = (key, value) => { bot.controlState[key] = value; };
  bot.clearControlStates = () => { for (const key of Object.keys(bot.controlState)) bot.controlState[key] = false; };
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; };
  bot.stopDigging = () => assert.fail('terrain fixture must never dig');
  bot.placeBlock = () => assert.fail('terrain fixture must never place');
  bot.activateBlock = () => assert.fail('terrain fixture must never open a block');
  bot.deactivateItem = () => {};
  bot.physics = Physics(data, { getBlock: point => bot.blockAt(point) });
  pathfinder(bot);
  const movement = new Movements(bot);
  movement.canDig = false; movement.allow1by1towers = false; movement.allowParkour = false; movement.scafoldingBlocks = [];
  bot.pathfinder.setMovements(movement);
  return { bot, movement };
}

function waterCorridor(p, name = 'water', props = { level: 0 }) {
  if (Math.abs(p.x) > 4 || Math.abs(p.z) > 1 || p.y < 64 || p.y > 68) return null;
  if (p.y === 64 || p.y === 67 || p.z !== 0 || Math.abs(p.x) === 4) return ['stone'];
  if (p.x === 0 && p.y === 65) return [name, props];
  return ['air'];
}

test('upstream shallow-water route exists but the guarded policy rejects it', async () => {
  const { bot, movement } = fixture(waterCorridor);
  const goal = new goals.GoalBlock(2, 65, 0);
  assert.equal(bot.pathfinder.getPathTo(movement, goal, 1000).status, 'success');
  (await safety).constrainMovements(bot, movement);
  assert.equal(bot.pathfinder.getPathTo(movement, goal, 1000).status, 'noPath');
});

for (const [name, props] of [['bubble_column', { drag: false }], ['seagrass', {}], ['oak_slab', { type: 'bottom', waterlogged: true }]]) {
  test(`guarded actual planner does not enter ${name}`, async () => {
    const { bot, movement } = fixture(p => waterCorridor(p, name, props));
    (await safety).constrainMovements(bot, movement);
    assert.equal(bot.pathfinder.getPathTo(movement, new goals.GoalBlock(2, 65, 0), 1000).status, 'noPath');
  });
}

function ladderShaft(p, name = 'ladder') {
  if (Math.abs(p.x) > 1 || Math.abs(p.z) > 1 || p.y < 64 || p.y > 74) return null;
  if (p.y === 64 || p.x !== 0 || p.z !== 0) return ['stone'];
  if (p.y <= 71) return [name, name === 'ladder' ? { facing: 'west', waterlogged: false } : { east: true }];
  return ['air'];
}

test('guarded planner retains the locked ladder ascent path', async () => {
  const { bot, movement } = fixture(ladderShaft);
  bot.entity.position = new Vec3(0.5, 65, 0.5);
  (await safety).constrainMovements(bot, movement);
  const route = bot.pathfinder.getPathTo(movement, new goals.GoalY(69), 1000);
  assert.equal(route.status, 'success');
  assert.ok(route.path.every(node => node.toBreak.length === 0 && node.toPlace.length === 0));
});

test('locked physics can ascend and descend a straight dry ladder with explicit controls', () => {
  const { bot } = fixture(ladderShaft);
  bot.entity.position = new Vec3(0.5, 65, 0.5);
  const state = new PlayerState(bot, { ...bot.controlState, forward: true, jump: true });
  state.yaw = -Math.PI / 2;
  const world = { getBlock: point => bot.blockAt(point) };
  for (let tick = 0; tick < 35; tick++) bot.physics.simulatePlayer(state, world);
  assert.ok(state.pos.y > 68 && state.pos.y < 72, `expected bounded ascent, got ${state.pos.y}`);
  state.control.forward = false; state.control.jump = false;
  for (let tick = 0; tick < 100; tick++) bot.physics.simulatePlayer(state, world);
  assert.ok(Math.abs(state.pos.y - 65) < 0.01, `expected descent to shaft floor, got ${state.pos.y}`);
});

test('vine ascent is not silently added to the locked ladder planner', async () => {
  const { bot, movement } = fixture(p => ladderShaft(p, 'vine'));
  bot.entity.position = new Vec3(0.5, 65, 0.5);
  (await safety).constrainMovements(bot, movement);
  assert.equal(bot.pathfinder.getPathTo(movement, new goals.GoalY(69), 1000).status, 'noPath');
});

test('loaded source-water physics supports only the tested vertical escape control', async () => {
  const { bot } = fixture(p => {
    if (Math.abs(p.x) > 2 || Math.abs(p.z) > 2 || p.y < 62 || p.y > 72) return null;
    return [p.y < 63 ? 'stone' : p.y <= 67 ? 'water' : 'air', {}];
  });
  bot.entity.position = new Vec3(0.5, 64, 0.5); bot.entity.isInWater = true;
  const state = new PlayerState(bot, { ...bot.controlState, jump: true });
  const world = { getBlock: point => bot.blockAt(point) };
  for (let tick = 0; tick < 100; tick++) bot.physics.simulatePlayer(state, world);
  assert.ok(state.pos.y + 1.62 >= 68, `expected eye above waterline, got ${state.pos.y}`);
  assert.equal(state.pos.x, 0.5); assert.equal(state.pos.z, 0.5);
});
