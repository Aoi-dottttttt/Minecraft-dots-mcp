import test from 'ava';
import minecraftData from 'minecraft-data';
import { planBlueprint, type BlueprintWorld, type BlueprintInput } from '../src/blueprint-plan.js';
import type { Position } from '../src/bounded-workflows.js';
const data = minecraftData('1.21.1');
const stone = data.blocksByName.stone.defaultState, air = data.blocksByName.air.defaultState;
const position = { x: 0, y: 64, z: 0 };
function input(states: number[] = [stone]): BlueprintInput {
  return { version: '1.21.1', size: { x: 1, y: states.length, z: 1 }, offset: { x: 0, y: 0, z: 0 }, palette: states, blocks: states.map((_state, index) => index) };
}
function world(overrides: Partial<BlueprintWorld> = {}): BlueprintWorld {
  return { position, knownState: stateId => data.blocksByStateId[stateId], count: () => 64,
    blockAt: (pos: Position) => pos.y < 64 ? { name: 'stone', stateId: stone, boundingBox: 'block' } : { name: 'air', stateId: air, boundingBox: 'empty' }, ...overrides };
}

test('blueprint: prismarine-schematic offset/order produces supported bottom-up placement and exact materials', t => {
  const blueprint = input([stone, stone]); blueprint.offset.x = 2;
  const result = planBlueprint(blueprint, position, world());
  t.true(result.executable); t.deepEqual(result.materials, [{ item: 'stone', required: 2, available: 64, missing: 0 }]);
  t.deepEqual(result.steps.map(step => step.position), [{ x: 2, y: 64, z: 0 }, { x: 2, y: 65, z: 0 }]);
});

test('blueprint: air cells preserve existing structures and occupied desired cells block the plan', t => {
  const occupied = world({ blockAt: () => ({ name: 'chest', stateId: data.blocksByName.chest.defaultState, boundingBox: 'block' }) });
  const untouched = planBlueprint(input([air]), position, occupied);
  t.is(untouched.ignoredAir, 1); t.is(untouched.steps.length, 0); t.is(untouched.blockers.length, 0);
  const conflict = planBlueprint(input(), position, occupied);
  t.false(conflict.executable); t.regex(conflict.blockers[0].reason, /removal and replacement are forbidden/);
});

test('blueprint: unknown state, malformed volume/palette, unsupported block and unobserved target reject', t => {
  t.throws(() => planBlueprint(input([99999]), position, world()), { message: /Unknown block state/ });
  t.throws(() => planBlueprint({ ...input(), blocks: [0, 0] }, position, world()));
  t.throws(() => planBlueprint({ ...input(), blocks: [1] }, position, world()));
  t.false(planBlueprint(input([data.blocksByName.tnt.defaultState]), position, world()).executable);
  t.false(planBlueprint(input([data.blocksByName.oak_log.defaultState]), position, world()).executable);
  t.false(planBlueprint(input(), position, world({ blockAt: () => null })).executable);
});

test('blueprint: missing material and floating construction remain plans without executable claims', t => {
  const missing = planBlueprint(input(), position, world({ count: () => 0 }));
  t.false(missing.executable); t.is(missing.materials[0].missing, 1);
  const floating = planBlueprint(input(), { ...position, y: 70 }, world());
  t.false(floating.executable); t.regex(floating.blockers[0].reason, /No observed solid support/);
  const existing = planBlueprint(input(), position, world({ blockAt: () => ({ name: 'stone', stateId: stone, boundingBox: 'block' }) }));
  t.is(existing.alreadyPresent, 1); t.deepEqual(existing.materials, []); t.deepEqual(existing.steps, []);
});
