// Neutral, offline fixtures using this repository's locked pathfinder and physics.
// Simulated motion is not evidence of a real server connection or acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Physics, PlayerState } = require('prismarine-physics');
const data = require('minecraft-data')('1.21.1');
const Block = require('prismarine-block')(data);
const Move = require('mineflayer-pathfinder/lib/move');
const entry = import('../dist/tools/movement-utils.js');

function fixture({ facing = 'north', hinge = 'left', open = true, name = 'oak_door', acrossLeaf = false, missingUpper = false, missingLower = false, upperOpen = open, upperFacing = facing, upperHinge = hinge, obstacle = false, double = false, transformBlock } = {}) {
  const axis = (facing === 'north' || facing === 'south') !== acrossLeaf ? 'z' : 'x';
  const bot = new EventEmitter();
  const toWorld = (long, cross, y) => axis === 'z' ? new Vec3(cross, y, long) : new Vec3(long, y, cross);
  bot.version = '1.21.1'; bot.registry = data; bot.game = { minY: -64 }; bot.entities = {};
  bot.controlState = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  bot.inventory = { items: () => [], slots: [] };
  bot.entity = { position: toWorld(-2, 0, 65).offset(0.5, 0, 0.5), velocity: new Vec3(0, 0, 0), onGround: true,
    yaw: 0, pitch: 0, effects: {}, attributes: {}, height: 1.8, width: 0.6 };
  bot.jumpTicks = 0; bot.jumpQueued = false; bot.fireworkRocketDuration = 0;
  bot.clearControlStates = () => Object.keys(bot.controlState).forEach(key => { bot.controlState[key] = false; });
  bot.setControlState = (key, value) => { bot.controlState[key] = value; };
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; };
  bot.stopDigging = () => assert.fail('digging not authorized');
  bot.activateBlock = () => assert.fail('automatic opening not authorized');
  bot.placeBlock = () => assert.fail('placing not authorized'); bot.deactivateItem = () => {};
  const state = { open, upperOpen };
  const blocks = new Map();
  bot.blockAt = position => {
    const p = position.floored(); const long = p[axis], cross = axis === 'z' ? p.x : p.z;
    const cacheKey = `${p}:${state.open}:${state.upperOpen}`;
    if (blocks.has(cacheKey)) return blocks.get(cacheKey);
    let block;
    if (Math.abs(long) > 4 || Math.abs(cross) > 3 || p.y < 64 || p.y > 68) return null;
    if (p.y === 64 || p.y === 67 || long === -3 || long === 3 || cross < 0 || cross > (double ? 1 : 0)) block = Block.fromProperties('stone', {}, 0);
    else if (long === 0 && p.y >= 65 && p.y <= 66 && (!missingUpper || p.y !== 66) && (!missingLower || p.y !== 65)) block = Block.fromProperties(obstacle ? 'stone' : name, obstacle ? {} : {
      open: p.y === 65 ? state.open : state.upperOpen, half: p.y === 65 ? 'lower' : 'upper', facing: p.y === 65 ? facing : upperFacing,
      hinge: double && cross === 1 ? 'right' : p.y === 65 ? hinge : upperHinge, powered: false
    }, 0);
    else block = Block.fromProperties('air', {}, 0);
    block.position = p; transformBlock?.(block); blocks.set(cacheKey, block); return block;
  };
  bot.physics = Physics(data, { getBlock: pos => bot.blockAt(pos) }); pathfinder(bot);
  const original = new Movements(bot);
  original.canDig = false; original.allow1by1towers = false; original.allowParkour = false; original.scafoldingBlocks = [];
  bot.pathfinder.setMovements(original);
  const goalPos = toWorld(2, 0, 65); const goal = new goals.GoalNear(goalPos.x, goalPos.y, goalPos.z, 0);
  return { bot, original, goal, goalPos, axis, toWorld, state };
}

test('regression: moveAndVerify permits actual A* through an already-open wooden doorway', async () => {
  const f = fixture(); const { moveAndVerify } = await entry;
  assert.equal(f.bot.pathfinder.getPathTo(f.original, f.goal, 1000).status, 'noPath');
  f.bot.pathfinder.goto = async goal => {
    const result = f.bot.pathfinder.getPathTo(f.bot.pathfinder.movements, goal, 1000);
    assert.equal(result.status, 'success', 'the installed navigation policy must allow the open doorway');
    // Planner-only test: supply end-position evidence separately; no live movement claim.
    f.bot.entity.position = f.goalPos.offset(0.5, 0, 0.5);
  };
  await moveAndVerify(f.bot, f.goal, 2000);
  assert.equal(f.bot.pathfinder.movements, f.original);
});

function listenerSnapshot(bot) {
  return new Map(bot.eventNames().map(name => [name, bot.listeners(name)]));
}

function assertRestored(f, before = f.listeners) {
  assert.equal(f.bot.pathfinder.movements, f.original, 'restore exact caller movement policy');
  assert.deepEqual(listenerSnapshot(f.bot), before, 'remove only operation listeners');
}

function simulateWaypoints(bot, points) {
  const state = new PlayerState(bot, { ...bot.controlState });
  const world = { getBlock: pos => bot.blockAt(pos) };
  assert.equal(bot.physics.playerHalfWidth * 2, 0.6);
  for (const target of points) {
    let arrived = false;
    for (let ticks = 0; ticks < 200; ticks++) {
      if (Math.hypot(target.x - state.pos.x, target.z - state.pos.z) < 0.15 && Math.abs(target.y - state.pos.y) < 0.01) {
        arrived = true; break;
      }
      state.yaw = Math.atan2(state.pos.x - target.x, state.pos.z - target.z);
      state.control.forward = true; state.control.jump = false; state.control.sprint = false;
      bot.physics.simulatePlayer(state, world);
    }
    if (!arrived) return { arrived, state, target };
  }
  return { arrived: true, state };
}

async function runPlan(options, check, configure) {
  const f = fixture(options); configure?.(f); f.listeners = listenerSnapshot(f.bot);
  const { moveAndVerify } = await entry;
  let result, error;
  f.bot.pathfinder.goto = async goal => {
    assert.notEqual(f.bot.pathfinder.movements, f.original);
    result = f.bot.pathfinder.getPathTo(f.bot.pathfinder.movements, goal, 1000);
    f.bot.emit('path_update', result);
    check?.(f, result);
    if (result.status !== 'success') throw new Error(`Offline A* result: ${result.status}`);
    // This helper tests planning only, not controller or server movement.
    f.bot.entity.position = f.goalPos.offset(0.5, 0, 0.5);
  };
  try { await moveAndVerify(f.bot, f.goal, 2000); } catch (e) { error = e; }
  assertRestored(f);
  return { ...f, result, error };
}

async function runController(f, goal = f.goal, configureActive) {
  const { moveAndVerify } = await entry;
  const listeners = listenerSnapshot(f.bot);
  let settled = false, failure;
  const pathUpdates = [];
  const capturePath = result => pathUpdates.push({ status: result.status, path: result.path.map(point => ({
    x: point.x, y: point.y, z: point.z, hash: point.hash,
    toBreak: [...point.toBreak], toPlace: [...point.toPlace], parkour: point.parkour
  })) });
  // Capture controller planning evidence; actual goto consumes the same path
  // after all synchronous adapter listeners have processed it.
  f.bot.on('path_update', capturePath);
  const task = moveAndVerify(f.bot, goal, 2000).catch(error => { failure = error; }).finally(() => { settled = true; });
  configureActive?.(f.bot.pathfinder.movements);
  await new Promise(resolve => setImmediate(resolve));
  let ticks = 0;
  for (; ticks < 400 && !settled; ticks++) {
    f.bot.emit('physicsTick');
    const state = new PlayerState(f.bot, { ...f.bot.controlState });
    f.bot.physics.simulatePlayer(state, { getBlock: pos => f.bot.blockAt(pos) });
    state.apply(f.bot); // Offline numerical physics only; there is no network client.
    await new Promise(resolve => setImmediate(resolve));
  }
  if (!settled) f.bot.pathfinder.setGoal(null);
  await task;
  f.bot.removeListener('path_update', capturePath);
  assertRestored(f, listeners);
  assert.ifError(failure);
  assert.ok(ticks > 0 && ticks < 400, 'real goto settled while physics ticks were driven');
  assert.ok(pathUpdates.some(result => result.status === 'success'), 'actual controller performed a successful A* search');
  for (const result of pathUpdates) for (const point of result.path) {
    assert.deepEqual(point.toBreak, []); assert.deepEqual(point.toPlace, []); assert.equal(point.parkour, false);
  }
  assert.equal(goal.isEnd(f.bot.entity.position.floored()), true);
  return { ticks, pathUpdates };
}

test('locked dependency baseline treats both open door halves as physical and has no route', () => {
  const lock = require('../package-lock.json');
  for (const name of ['mineflayer-pathfinder', 'minecraft-data', 'prismarine-physics', 'prismarine-block']) {
    assert.equal(require(`${name}/package.json`).version, lock.packages[`node_modules/${name}`].version);
  }
  const f = fixture();
  for (const y of [65, 66]) {
    const block = f.original.getBlock(f.toWorld(0, 0, y), 0, 0, 0);
    assert.equal(block.getProperties().open, true);
    assert.equal(block.safe, false); assert.equal(block.physical, true);
  }
  assert.equal(f.bot.pathfinder.getPathTo(f.original, f.goal, 1000).status, 'noPath');
});

for (const facing of ['north', 'south', 'east', 'west']) for (const hinge of ['left', 'right']) {
  test(`actual A* and offline 0.6-wide collision physics pass ${facing}/${hinge}`, async () => {
    const r = await runPlan({ facing, hinge }, (f, result) => {
      assert.equal(result.status, 'success');
      const doorPoints = result.path.filter(point => point.hash === '0,65,0');
      assert.equal(doorPoints.length, 1);
      assert.deepEqual([doorPoints[0].x, doorPoints[0].y, doorPoints[0].z], [0.5, 65, 0.5]);
      for (const point of result.path) {
        assert.deepEqual(point.toBreak, []); assert.deepEqual(point.toPlace, []); assert.equal(point.parkour, false);
      }
      for (const y of [65, 66]) {
        const worldBlock = f.bot.blockAt(new Vec3(0, y, 0));
        const shapes = worldBlock.shapes, shapeValues = structuredClone(shapes);
        const planned = f.bot.pathfinder.movements.getBlock(new Vec3(0, y, 0), 0, 0, 0);
        assert.equal(planned.safe, true); assert.equal(planned.physical, false); assert.equal(planned.height, y);
        assert.notEqual(planned, worldBlock);
        assert.equal(worldBlock.boundingBox, 'block'); assert.equal(worldBlock.shapes, shapes);
        assert.deepEqual(worldBlock.shapes, shapeValues); assert.equal(planned.shapes, shapes);
      }
      assert.equal(simulateWaypoints(f.bot, result.path).arrived, true);
    });
    assert.ifError(r.error);
  });
  test(`actual goto controller and offline physics cross ${facing}/${hinge}`, async () => {
    const f = fixture({ facing, hinge });
    const worldBlock = f.bot.blockAt(new Vec3(0, 65, 0)); const shapes = worldBlock.shapes;
    await runController(f);
    assert.equal(f.bot.blockAt(new Vec3(0, 65, 0)), worldBlock);
    assert.equal(worldBlock.boundingBox, 'block'); assert.equal(worldBlock.shapes, shapes);
    assert.equal(shapes.length, 1);
  });
}

for (const name of ['spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door', 'mangrove_door', 'cherry_door', 'bamboo_door', 'crimson_door', 'warped_door']) {
  test(`${name} uses its actual registered collision shapes`, async () => {
    const r = await runPlan({ name }, (f, result) => {
      assert.equal(result.status, 'success');
      assert.equal(simulateWaypoints(f.bot, result.path).arrived, true);
    });
    assert.ifError(r.error);
  });
}

for (const [name, options] of Object.entries({
  'closed door': { open: false }, 'closed upper half': { upperOpen: false },
  'closed lower half': { open: false, upperOpen: true }, 'missing upper half': { missingUpper: true },
  'missing lower half': { missingLower: true }, 'mismatched facing': { upperFacing: 'east' },
  'mismatched hinge': { upperHinge: 'right' }, 'solid wall': { obstacle: true },
  'open iron door': { name: 'iron_door' }, 'open copper door': { name: 'copper_door' },
  'sideways crossing through leaf': { acrossLeaf: true }
})) test(`${name} stays blocked by actual A*`, async () => {
  const r = await runPlan(options);
  assert.equal(r.result?.status, 'noPath'); assert.match(r.error?.message ?? '', /Offline A\* result: noPath/);
});

for (const [label, shapes] of [
  ['empty', []], ['center obstruction', [[0.4, 0, 0, 0.6, 1, 1]]],
  ['passage narrower than 0.6', [[0, 0, 0, 0.20001, 1, 1]]],
  ['non-finite', [[0, 0, 0, NaN, 1, 1]]], ['out-of-cell', [[-0.01, 0, 0, 0.18, 1, 1]]],
  ['zero width', [[0, 0, 0, 0, 1, 1]]], ['reversed bounds', [[0.18, 0, 0, 0.1, 1, 1]]],
  ['short shape', [[0, 0, 0, 0.18, 1]]], ['extra component', [[0, 0, 0, 0.18, 1, 1, 9]]]
]) test(`unfamiliar ${label} door shapes fail closed`, async () => {
  const r = await runPlan({ transformBlock(block) { if (block.name === 'oak_door') block.shapes = shapes; } });
  assert.equal(r.result?.status, 'noPath'); assert.ok(r.error);
});

test('unknown hinge fails closed even when both halves agree', async () => {
  const r = await runPlan({ transformBlock(block) {
    if (block.name !== 'oak_door') return;
    const props = block.getProperties(); block.getProperties = () => ({ ...props, hinge: 'unknown' });
  } });
  assert.equal(r.result?.status, 'noPath'); assert.ok(r.error);
});

test('exactly 0.6-wide clear corridor is accepted and traversed by actual physics', async () => {
  const shapes = [[0, 0, 0, 0.2, 1, 1], [0.8, 0, 0, 1, 1, 1]];
  const r = await runPlan({ transformBlock(block) { if (block.name === 'oak_door') block.shapes = shapes; } }, (f, result) => {
    assert.equal(result.status, 'success'); assert.equal(simulateWaypoints(f.bot, result.path).arrived, true);
  });
  assert.ifError(r.error);
});

test('paired open doors permit both openings and keep both physical leaves', async () => {
  const r = await runPlan({ double: true }, (f, result) => {
    assert.equal(result.status, 'success'); assert.equal(simulateWaypoints(f.bot, result.path).arrived, true);
    for (const x of [0, 1]) for (const y of [65, 66]) {
      const world = f.bot.blockAt(new Vec3(x, y, 0));
      const planned = f.bot.pathfinder.movements.getBlock(new Vec3(x, y, 0), 0, 0, 0);
      assert.equal(planned.safe, true); assert.equal(planned.shapes, world.shapes);
      assert.equal(world.boundingBox, 'block'); assert.equal(world.shapes.length, 1);
    }
  });
  assert.ifError(r.error);
});

test('door-adjacent diagonal and side steps are filtered, while straight neighbors remain', async () => {
  const r = await runPlan({ double: true }, f => {
    const movement = f.bot.pathfinder.movements;
    const neighbors = movement.getNeighbors(new Move(0, 65, 0, 0, 0));
    assert.ok(neighbors.some(point => point.z === -1)); assert.ok(neighbors.some(point => point.z === 1));
    assert.ok(neighbors.every(point => point.x === 0 && point.y === 65));
    const approaching = movement.getNeighbors(new Move(1, 65, -1, 0, 0));
    assert.ok(!approaching.some(point => point.x === 0 && point.z === 0), 'no diagonal entry into door');
  });
  assert.ifError(r.error);
});

test('closing after planning remains a physical obstacle and blocks the next search', async () => {
  const r = await runPlan({}, (f, result) => {
    assert.equal(result.status, 'success');
    f.state.open = f.state.upperOpen = false;
    assert.equal(simulateWaypoints(f.bot, result.path).arrived, false);
    assert.equal(f.bot.pathfinder.getPathTo(f.bot.pathfinder.movements, f.goal, 1000).status, 'noPath');
  });
  assert.ifError(r.error);
});

test('exclusion costs are preserved for passable door nodes', async () => {
  const r = await runPlan({}, (f, result) => {
    assert.equal(result.status, 'success');
    const door = f.bot.pathfinder.movements.getNeighbors(new Move(0, 65, -1, 0, 0)).find(point => point.z === 0);
    // Upstream charges exclusionStep on entry and in safeOrBreak for both halves.
    assert.equal(door.cost, 1 + 7 + 7 + 7);
    assert.deepEqual(f.bot.pathfinder.movements.exclusionAreasStep.slice(0, f.original.exclusionAreasStep.length), f.original.exclusionAreasStep);
  }, f => { f.original.exclusionAreasStep.push(block => block.name === 'oak_door' ? 7 : 0); });
  assert.ifError(r.error); assert.equal(r.original.exclusionAreasStep.length, 1);
});

for (const mode of ['exclusion cost', 'blocksToAvoid']) test(`${mode} can prohibit an open door`, async () => {
  const r = await runPlan({}, undefined, f => {
    if (mode === 'exclusion cost') f.original.exclusionAreasStep.push(block => block.name === 'oak_door' ? 100 : 0);
    else f.original.blocksToAvoid.add(data.blocksByName.oak_door.id);
  });
  assert.equal(r.result?.status, 'noPath'); assert.ok(r.error);
});

test('non-door block flags and shapes are unchanged; unsafe movement options are scoped', async () => {
  const r = await runPlan({}, f => {
    const active = f.bot.pathfinder.movements;
    for (const key of ['canDig', 'canOpenDoors', 'allow1by1towers', 'allowParkour', 'allowFreeMotion']) assert.equal(active[key], false);
    assert.deepEqual(active.scafoldingBlocks, []);
    for (const position of [new Vec3(0, 64, -1), new Vec3(0, 65, -1), new Vec3(-1, 65, -1)]) {
      const world = f.bot.blockAt(position); const shapes = world.shapes;
      const baseline = f.original.getBlock(position, 0, 0, 0);
      const flags = ['safe', 'physical', 'height', 'liquid', 'climbable', 'replaceable', 'openable'];
      const expected = Object.fromEntries(flags.map(key => [key, baseline[key]]));
      const actual = active.getBlock(position, 0, 0, 0);
      assert.deepEqual(Object.fromEntries(flags.map(key => [key, actual[key]])), expected);
      assert.equal(actual.shapes, shapes); assert.equal(world.shapes, shapes);
    }
  }, f => {
    f.original.canDig = true; f.original.canOpenDoors = true; f.original.allow1by1towers = true;
    f.original.allowParkour = true; f.original.allowFreeMotion = true;
    f.original.scafoldingBlocks = [data.blocksByName.dirt.id];
  });
  assert.ifError(r.error);
  for (const key of ['canDig', 'canOpenDoors', 'allow1by1towers', 'allowParkour', 'allowFreeMotion']) assert.equal(r.original[key], true);
  assert.deepEqual(r.original.scafoldingBlocks, [data.blocksByName.dirt.id]);
});

test('actual controller handles a neutral offset room approach to one open doorway', async () => {
  const f = fixture({ double: true, transformBlock(block) {
    if (block.position.x === 1 && block.position.z === 0 && [65, 66].includes(block.position.y)) {
      const wall = Block.fromProperties('stone', {}, 0); Object.assign(block, wall);
    }
  } });
  f.bot.entity.position = new Vec3(1.48, 65, 1.76);
  const goal = new goals.GoalNear(0, 65, -1, 0);
  await runController(f, goal);
});

for (const support of ['stone', 'stone_slab']) test(`raised ${support} door threshold stays outside the straight same-height adapter`, async () => {
  const r = await runPlan({}, undefined, f => {
    const original = f.bot.blockAt;
    f.bot.blockAt = position => {
      const p = position.floored();
      if (p.x !== 0 || p.z !== 0 || p.y < 65 || p.y > 67) return original(position);
      const block = p.y === 65 ? Block.fromProperties(support, support === 'stone_slab' ? { type: 'bottom', waterlogged: false } : {}, 0)
        : Block.fromProperties('oak_door', { open: true, half: p.y === 66 ? 'lower' : 'upper', facing: 'north', hinge: 'left', powered: false }, 0);
      block.position = p; return block;
    };
  });
  assert.equal(r.result?.status, 'noPath'); assert.ok(r.error);
});

for (const mode of ['synchronous throw', 'async reject', 'cancel', 'timeout', 'missed goal', 'death then cancel', 'disconnect then timeout']) {
  test(`${mode} restores exact movement policy and listener baseline`, async () => {
    const f = fixture(); const before = listenerSnapshot(f.bot); const { moveAndVerify } = await entry;
    const actualGoto = f.bot.pathfinder.goto;
    let entered; const entering = new Promise(resolve => { entered = resolve; });
    f.bot.pathfinder.goto = goal => {
      entered(); f.bot.setControlState('forward', true);
      if (mode === 'synchronous throw') throw new Error('synthetic synchronous failure');
      if (mode === 'async reject') return Promise.reject(new Error('synthetic asynchronous failure'));
      if (mode === 'missed goal') return Promise.resolve();
      return actualGoto(goal);
    };
    const task = moveAndVerify(f.bot, f.goal, 40);
    await entering;
    assert.notEqual(f.bot.pathfinder.movements, f.original);
    if (mode === 'death then cancel') f.bot.emit('death');
    if (mode === 'disconnect then timeout') f.bot.emit('end', 'neutral fixture disconnect');
    if (mode === 'cancel' || mode === 'death then cancel') f.bot.pathfinder.setGoal(null);
    const expected = mode.startsWith('death') || mode.startsWith('disconnect') ? /Session ended or player died/ : mode.includes('timeout') ? /timed out/ : mode === 'missed goal' ? /without reaching/ :
      mode.includes('cancel') ? /goal was changed/ : /synthetic .* failure/;
    await assert.rejects(task, expected);
    assertRestored(f, before);
    assert.equal(f.bot.pathfinder.goal, null);
    assert.ok(Object.values(f.bot.controlState).every(value => value === false));
  });
}

test('movement installation failure rolls back its partial installation and listeners', async () => {
  const f = fixture(); const before = listenerSnapshot(f.bot); const { moveAndVerify } = await entry;
  const setMovements = f.bot.pathfinder.setMovements;
  f.bot.pathfinder.setMovements = movements => {
    setMovements(movements);
    if (movements !== f.original) throw new Error('synthetic installation failure');
  };
  await assert.rejects(moveAndVerify(f.bot, f.goal, 200), /installation failure/);
  assertRestored(f, before);
});

test('a newer caller-installed movements object is not overwritten by cleanup', async () => {
  const f = fixture(); const before = listenerSnapshot(f.bot); const { moveAndVerify } = await entry;
  const newer = new Movements(f.bot);
  f.bot.pathfinder.goto = async () => {
    f.bot.pathfinder.setMovements(newer);
    const stale = new Move(0, 65, 0, 0, 0); stale.set(0.15, 66, 0.45);
    f.bot.emit('path_update', { status: 'success', path: [stale] });
    assert.deepEqual([stale.x, stale.y, stale.z], [0.15, 66, 0.45], 'stale adapter cannot modify a newer policy path');
    f.bot.entity.position = f.goalPos.offset(0.5, 0, 0.5);
  };
  await moveAndVerify(f.bot, f.goal, 200);
  assert.equal(f.bot.pathfinder.movements, newer); assert.deepEqual(listenerSnapshot(f.bot), before);
});

test('repeated successful and cancelled operations leave no adapter or goto listeners', async () => {
  const f = fixture(); const before = listenerSnapshot(f.bot); const { moveAndVerify } = await entry;
  const actualGoto = f.bot.pathfinder.goto;
  for (let iteration = 0; iteration < 20; iteration++) {
    f.bot.entity.position = f.toWorld(-2, 0, 65).offset(0.5, 0, 0.5);
    f.bot.pathfinder.goto = iteration % 2 === 0 ? async () => { f.bot.entity.position = f.goalPos.offset(0.5, 0, 0.5); } : actualGoto;
    const task = moveAndVerify(f.bot, f.goal, 200);
    if (iteration % 2) {
      await new Promise(resolve => setImmediate(resolve)); f.bot.pathfinder.setGoal(null);
      await assert.rejects(task, /goal was changed/);
    } else await task;
    assertRestored(f, before);
  }
});

for (const [label, missing] of [['undefined', undefined], ['null array', null], ['null shape', [null]]]) test(`missing or null geometry (${label}) cannot become a passable route`, async () => {
  const r = await runPlan({ transformBlock(block) { if (block.name === 'oak_door') block.shapes = missing; } });
  // Locked upstream getBlock cannot iterate this malformed geometry. It throws;
  // the verified helper must reject and restore rather than claim a route.
  assert.ok(r.error instanceof TypeError); assert.equal(r.result, undefined);
  assert.ok(Object.values(r.bot.controlState).every(value => value === false));
});

for (const [label, changes] of [
  ['unknown facing', { facing: 'unknown' }], ['wrong upper half marker', { half: 'lower' }],
  ['missing hinge property', { hinge: undefined }], ['nonboolean open property', { open: 'true' }]
]) test(`${label} cannot authorize an open door passage`, async () => {
  const r = await runPlan({ transformBlock(block) {
    if (block.name !== 'oak_door' || block.position.y !== 66) return;
    const props = block.getProperties(); block.getProperties = () => ({ ...props, ...changes });
  } });
  assert.equal(r.result?.status, 'noPath'); assert.ok(r.error);
});

test('different wood species in the two halves fail closed', async () => {
  const r = await runPlan({ transformBlock(block) {
    if (block.name === 'oak_door' && block.position.y === 66) block.name = 'spruce_door';
  } });
  assert.equal(r.result?.status, 'noPath'); assert.ok(r.error);
});

test('caller entity avoidance stays effective at the open doorway', async () => {
  const r = await runPlan({}, undefined, f => {
    f.original.entitiesToAvoid.add('neutral_obstacle');
    f.bot.entities[2] = { id: 2, name: 'neutral_obstacle', position: new Vec3(0.5, 65, 0.5), width: 0.6, height: 1.8 };
  });
  assert.equal(r.result?.status, 'noPath'); assert.ok(r.error);
});

test('timeout keeps the adapted movements installed until the real goto promise settles', async () => {
  const f = fixture(); const before = listenerSnapshot(f.bot); const { moveAndVerify } = await entry;
  const actualGoto = f.bot.pathfinder.goto;
  let release; const gate = new Promise(resolve => { release = resolve; });
  let sawCancellation; const cancelled = new Promise(resolve => { sawCancellation = resolve; });
  const onGoal = goal => { if (goal === null) sawCancellation(); };
  f.bot.on('goal_updated', onGoal);
  f.bot.pathfinder.goto = goal => actualGoto(goal).finally(() => gate);
  let settled = false;
  const task = moveAndVerify(f.bot, f.goal, 20).finally(() => { settled = true; });
  // Attach the rejection observer before the timeout can fire.
  const rejection = assert.rejects(task, /timed out/);
  await cancelled;
  assert.equal(settled, false); assert.notEqual(f.bot.pathfinder.movements, f.original);
  f.bot.removeListener('goal_updated', onGoal); release();
  await rejection; assertRestored(f, before);
});

test('a newer movement policy also survives failure cleanup', async () => {
  const f = fixture(); const before = listenerSnapshot(f.bot); const { moveAndVerify } = await entry;
  const newer = new Movements(f.bot);
  f.bot.pathfinder.goto = async () => {
    f.bot.pathfinder.setMovements(newer); throw new Error('synthetic later-owner failure');
  };
  await assert.rejects(moveAndVerify(f.bot, f.goal, 100), /later-owner failure/);
  assert.equal(f.bot.pathfinder.movements, newer); assert.deepEqual(listenerSnapshot(f.bot), before);
});

test('installation rejection before policy assignment preserves the original owner', async () => {
  const f = fixture(); const before = listenerSnapshot(f.bot); const { moveAndVerify } = await entry;
  f.bot.pathfinder.setMovements = () => { throw new Error('synthetic early installation failure'); };
  await assert.rejects(moveAndVerify(f.bot, f.goal, 100), /early installation failure/);
  assertRestored(f, before);
});

test('air-to-air diagonal cannot clip the door leaf in the adjacent swept cell', async () => {
  const r = await runPlan({}, (f, result) => {
    assert.equal(f.bot.blockAt(f.bot.entity.position).name, 'air');
    assert.equal(f.bot.blockAt(f.goalPos).name, 'air');
    assert.equal(simulateWaypoints(f.bot, [f.goalPos.offset(0.5, 0, 0.5)]).arrived, false,
      'the actual collision leaf blocks this diagonal');
    assert.equal(result.status, 'noPath', 'A* must not route diagonally through the neighboring door cell');
  }, f => {
    f.bot.entity.position = new Vec3(0.5, 65, -0.5);
    f.goalPos = new Vec3(1, 65, 0); f.goal = new goals.GoalBlock(1, 65, 0);
    f.bot.blockAt = position => {
      const p = position.floored(); let block;
      if (p.y < 64 || p.y > 68 || Math.abs(p.x) > 4 || Math.abs(p.z) > 4) return null;
      if (p.y === 64 || p.y === 67) block = Block.fromProperties('stone', {}, 0);
      else if (p.x === 0 && p.z === 0 && [65, 66].includes(p.y)) block = Block.fromProperties('oak_door', {
        facing: 'north', hinge: 'right', open: true, half: p.y === 65 ? 'lower' : 'upper', powered: false
      }, 0);
      else if ((p.x === 0 && p.z === -1) || (p.x === 1 && p.z === 0)) block = Block.fromProperties('air', {}, 0);
      else block = Block.fromProperties('stone', {}, 0);
      block.position = p; return block;
    };
    assert.equal(f.bot.pathfinder.getPathTo(f.original, f.goal, 1000).status, 'noPath');
  });
  assert.equal(r.result?.status, 'noPath'); assert.match(r.error?.message ?? '', /Offline A\* result: noPath/);
});

test('a diagonal drop cannot sweep through a neighboring upper door half', async () => {
  const f = fixture(); const before = listenerSnapshot(f.bot); const { moveAndVerify } = await entry;
  const source = new Move(0, 67, -1, 0, 0); const destination = new Vec3(1, 66, 0);
  f.bot.entity.position = new Vec3(0.5, 67, -0.5);
  f.bot.blockAt = position => {
    const p = position.floored(); let block;
    if (p.y < 64 || p.y > 70 || Math.abs(p.x) > 4 || Math.abs(p.z) > 4) return null;
    if (p.x === 0 && p.z === 0 && [65, 66].includes(p.y)) block = Block.fromProperties('oak_door', {
      facing: 'north', hinge: 'right', open: true, half: p.y === 65 ? 'lower' : 'upper', powered: false
    }, 0);
    else if ((p.x === 0 && p.z === -1 && p.y === 66) || (p.x === 1 && p.z === 0 && p.y === 65) || p.y === 64) block = Block.fromProperties('stone', {}, 0);
    else block = Block.fromProperties('air', {}, 0);
    block.position = p; return block;
  };
  f.bot.pathfinder.goto = async () => {
    const active = f.bot.pathfinder.movements;
    const isDestination = point => point.equals(destination);
    // Real upstream neighbor generation supplies this drop when the planning
    // block adapter is active; only the edge filter must remove it.
    assert.ok(f.original.getNeighbors.call(active, source).some(isDestination));
    assert.ok(!active.getNeighbors(source).some(isDestination));
    assert.equal(f.bot.blockAt(source).name, 'air'); assert.equal(f.bot.blockAt(destination).name, 'air');
    assert.equal(f.bot.blockAt(new Vec3(0, 66, 0)).getProperties().half, 'upper');
    f.bot.entity.position = f.goalPos.offset(0.5, 0, 0.5);
  };
  await moveAndVerify(f.bot, f.goal, 200); assertRestored(f, before);
});

test('head-height synthetic door geometry also blocks an air-to-air diagonal', async () => {
  const r = await runPlan({}, (f, result) => {
    const source = new Move(0, 65, -1, 0, 0); const active = f.bot.pathfinder.movements;
    assert.ok(f.original.getNeighbors.call(active, source).some(point => point.equals(f.goalPos)));
    assert.ok(!active.getNeighbors(source).some(point => point.equals(f.goalPos)));
    assert.equal(simulateWaypoints(f.bot, [f.goalPos.offset(0.5, 0, 0.5)]).arrived, false);
    assert.equal(result.status, 'noPath');
  }, f => {
    f.bot.entity.position = new Vec3(0.5, 65, -0.5);
    f.goalPos = new Vec3(1, 65, 0); f.goal = new goals.GoalBlock(1, 65, 0);
    f.bot.blockAt = position => {
      const p = position.floored(); let block;
      if (p.y < 64 || p.y > 69 || Math.abs(p.x) > 4 || Math.abs(p.z) > 4) return null;
      if (p.y === 64 || p.y === 68) block = Block.fromProperties('stone', {}, 0);
      else if (p.x === 0 && p.z === 0 && [66, 67].includes(p.y)) block = Block.fromProperties('oak_door', {
        facing: 'north', hinge: 'right', open: true, half: p.y === 66 ? 'lower' : 'upper', powered: false
      }, 0);
      // Deliberately unsupported/elevated pair: geometry safety fixture only,
      // not a claim that normal Minecraft placement produces this world.
      else if ((p.x === 0 && p.z === -1) || (p.x === 1 && p.z === 0) || (p.x === 0 && p.z === 0)) block = Block.fromProperties('air', {}, 0);
      else block = Block.fromProperties('stone', {}, 0);
      block.position = p; return block;
    };
  });
  assert.equal(r.result?.status, 'noPath'); assert.match(r.error?.message ?? '', /Offline A\* result: noPath/);
});

function forceOnePartialSearch(movements) {
  const getNeighbors = movements.getNeighbors; let first = true;
  movements.getNeighbors = function (node) {
    const result = getNeighbors.call(this, node);
    if (first) {
      first = false;
      // Deliberately exceed the actual A* per-tick budget after one expansion.
      // No invented path nodes: upstream produces and retains its own frontier.
      const started = performance.now(); while (performance.now() - started < 50) {}
    }
    return result;
  };
}

for (const facing of ['north', 'south', 'east', 'west']) test(`partial A* resumes from its centered ${facing} door frontier`, async () => {
  const f = fixture({ facing }); const before = listenerSnapshot(f.bot); const { moveAndVerify } = await entry;
  f.bot.entity.position = f.toWorld(-1, 0, 65).offset(0.5, 0, 0.5);
  f.bot.pathfinder.goto = async goal => {
    const active = f.bot.pathfinder.movements; forceOnePartialSearch(active);
    const search = f.bot.pathfinder.getPathFromTo(active, f.bot.entity.position, goal, { timeout: 1000, tickTimeout: 20 });
    const first = search.next().value.result;
    assert.equal(first.status, 'partial'); assert.equal(first.path.at(-1).hash, '0,65,0');
    f.bot.emit('path_update', first);
    const retained = first.path.at(-1); const centered = [retained.x, retained.y, retained.z];
    assert.deepEqual(centered, [0.5, 65, 0.5]);
    assert.ok(active.getNeighbors(retained).length > 0);
    assert.deepEqual([retained.x, retained.y, retained.z], centered, 'expansion must not move the live controller waypoint');
    const final = search.next().value.result; f.bot.emit('path_update', final);
    assert.equal(final.status, 'success');
    assert.equal(simulateWaypoints(f.bot, final.path).arrived, true);
    f.bot.entity.position = f.goalPos.offset(0.5, 0, 0.5);
  };
  await moveAndVerify(f.bot, f.goal, 2000); assertRestored(f, before);
});

test('actual goto and offline physics recover a partial search through the door', async () => {
  const f = fixture(); f.bot.entity.position = f.toWorld(-1, 0, 65).offset(0.5, 0, 0.5);
  f.bot.pathfinder.tickTimeout = 20;
  const result = await runController(f, f.goal, forceOnePartialSearch);
  assert.equal(result.pathUpdates[0].status, 'partial');
  assert.ok(result.pathUpdates.slice(1).some(update => update.status === 'success'));
});
