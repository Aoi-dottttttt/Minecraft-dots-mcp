/* eslint-disable @typescript-eslint/no-explicit-any */
import test from 'ava';
import { Vec3 } from 'vec3';
import { registerWorkflowTools } from '../src/tools/workflow-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import { windowFixture } from './helpers/window-fixture.js';

function fixture() {
  const s = windowFixture('minecraft:generic_9x3', 27, []);
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const server = { tool(name: string, _description: string, _schema: unknown, handler: (args: any) => Promise<any>) { handlers.set(name, handler); } };
  const factory = new ToolFactory(server as any, { checkConnectionAndReconnect: async () => ({ connected: true }) } as any);
  let dug = false, digs = 0;
  const target = { x: 1, y: 0, z: 0 }, chest = { x: 3, y: 0, z: 0 };
  Object.assign(s.bot, { health: 20, food: 20, game: { dimension: 'overworld' }, clearControlStates() {},
    pathfinder: { goto: async (goal: any) => { s.bot.entity.position = new Vec3(goal.x, goal.y, goal.z); }, setGoal() {} },
    blockAt: (pos: Vec3) => ({ name: pos.equals(new Vec3(3, 0, 0)) ? 'chest' : pos.equals(new Vec3(1, 0, 0)) && !dug ? 'dirt' : 'air', position: pos, stateId: 0 }),
  });
  s.slots[0] = s.item('bread', 3);
  const controller = new AbortController();
  const registered = registerWorkflowTools({ bot: s.bot, facade: { tool: { equipForBlock: async () => {} } }, factory, server,
    markRead: () => {}, runAction: operation => operation(), settings: () => ({ signal: controller.signal }), abortAction: () => controller.abort(),
    legacy: async name => {
      if (name !== 'dig-block') throw Error('Unexpected legacy action');
      digs++; dug = true; s.slots[27] = s.item('dirt', 1);
      s.bot._client.emit('set_slot', { windowId: 0, slot: 9, stateId: 2, item: s.authority.raw(s.slots[27] as any) });
      return {};
    },
  });
  const call = async (name: string, args: any): Promise<any> => {
    const response = await handlers.get(name)!(args);
    if (response.isError) throw Error(response.content[0].text);
    return response.structuredContent ?? JSON.parse(response.content[0].text);
  };
  const plan = () => call('plan-gather-workflow', { targets: [{ position: target, block: 'dirt', item: 'dirt' }], chest, deposit: [{ item: 'dirt', count: 1 }], restock: [{ item: 'bread', count: 2 }] });
  return { ...s, call, plan, registered, getDigs: () => digs, target, chest };
}

test('workflow tools: explicit gather, return, exact deposit and restock complete with server inventory evidence', async t => {
  const s = fixture();
  const plan = await s.plan(); t.is(s.getDigs(), 0); t.is(s.writes.length, 0);
  const result = await s.call('run-workflow', { id: plan.id, expectedRevision: 0, maxSteps: 4 });
  t.is(result.status, 'completed', result.error); t.is(s.getDigs(), 1);
  t.is(s.authority.count(s.bot.registry.itemsByName.dirt.id), 0); t.is(s.authority.count(s.bot.registry.itemsByName.bread.id), 2);
  t.is(s.slots.filter(item => item?.name === 'dirt').reduce((sum, item) => sum + item!.count, 0), 1);
  t.is(s.bot.currentWindow, null); t.is(s.authority.fence, null);
  t.true(result.steps.every((step: any) => step.status === 'confirmed'));
  await t.throwsAsync(s.call('run-workflow', { id: plan.id, expectedRevision: 0 }), { message: /revision/ });
  t.is(s.getDigs(), 1);
});

test('workflow tools: stale target, changed dimension and inventory fence halt before digging', async t => {
  for (const reason of ['target', 'dimension', 'fence']) {
    const s = fixture(); const plan = await s.plan();
    if (reason === 'target') s.bot.blockAt = (() => null) as any;
    if (reason === 'dimension') Object.assign(s.bot.game, { dimension: 'the_nether' });
    if (reason === 'fence') s.authority.block('fixture uncertainty');
    const result = await s.call('run-workflow', { id: plan.id, expectedRevision: 0 });
    t.is(result.status, 'failed'); t.is(s.getDigs(), 0); t.is(s.writes.length, 0);
  }
});

test('workflow tools: cancelling a ready plan never starts or replays it', async t => {
  const s = fixture(); const plan = await s.plan();
  const cancelled = await s.call('cancel-workflow', { id: plan.id });
  t.is(cancelled.status, 'cancelled'); t.is(s.getDigs(), 0);
  await t.throwsAsync(s.call('run-workflow', { id: plan.id, expectedRevision: cancelled.revision }), { message: /cancelled/ });
});

test('workflow tools: partial storage success is retained when restock is insufficient; no earlier step is replayed', async t => {
  const s = fixture(); s.slots[0] = s.item('bread', 1);
  const plan = await s.plan();
  const result = await s.call('run-workflow', { id: plan.id, expectedRevision: 0, maxSteps: 4 });
  t.is(result.status, 'failed'); t.is(result.nextStep, 3); t.is(s.getDigs(), 1);
  t.is(result.steps[2].status, 'confirmed'); t.is(result.steps[3].status, 'uncertain');
  t.is(s.authority.count(s.bot.registry.itemsByName.dirt.id), 0);
  await t.throwsAsync(s.call('run-workflow', { id: plan.id, expectedRevision: result.revision }), { message: /failed/ });
  t.is(s.getDigs(), 1);
});

test('workflow tools: blueprint placement consumes exactly one server-confirmed item and checks final state', async t => {
  const s = windowFixture('minecraft:generic_9x3', 27, [{ name: 'stone', count: 2, slot: 36 }]);
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const server = { tool(name: string, _description: string, _schema: unknown, handler: (args: any) => Promise<any>) { handlers.set(name, handler); } };
  const factory = new ToolFactory(server as any, { checkConnectionAndReconnect: async () => ({ connected: true }) } as any);
  const stone = s.bot.registry.blocksByName.stone.defaultState;
  const air = s.bot.registry.blocksByName.air.defaultState;
  let placed = false, calls = 0;
  Object.assign(s.bot, { health: 20, food: 20, game: { dimension: 'overworld' }, clearControlStates() {},
    pathfinder: { goto: async () => {}, setGoal() {} },
    blockAt: (pos: Vec3) => ({ name: pos.y < 0 || placed ? 'stone' : 'air', position: pos, stateId: pos.y < 0 || placed ? stone : air, boundingBox: pos.y < 0 || placed ? 'block' : 'empty' }),
  });
  registerWorkflowTools({ bot: s.bot, facade: {}, factory, server, markRead: () => {}, runAction: operation => operation(), settings: () => ({}), abortAction: () => {},
    legacy: async name => { t.is(name, 'place-block'); calls++; placed = true; s.bot._client.emit('set_slot', { windowId: 0, slot: 36, stateId: 2, item: s.authority.raw(s.item('stone', 1) as any) }); return {}; },
  });
  const plan = (await handlers.get('plan-blueprint-workflow')!({ origin: { x: 1, y: 0, z: 0 }, schematic: { version: '1.21.1', size: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, palette: [stone], blocks: [0] } })).structuredContent;
  t.is(calls, 0); t.is(plan.workflow.steps.length, 1);
  const result = (await handlers.get('run-workflow')!({ id: plan.workflow.id, expectedRevision: 0 })).structuredContent;
  t.is(result.status, 'completed', result.error); t.is(calls, 1);
  t.is(result.steps[0].evidence.consumed, 1); t.is(s.authority.count(s.bot.registry.itemsByName.stone.id), 1);
});
