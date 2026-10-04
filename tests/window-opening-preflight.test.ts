import test from 'ava';
import sinon from 'sinon';
import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import { ToolFactory } from '../src/tool-factory.js';
import { registerCompleteControls } from '../src/complete-controls.js';
import { FURNACE_WINDOW_TYPES, STORAGE_WINDOW_TYPES, openWindowVerified, validateWindowBlock } from '../src/verified-window-actions.js';
import { windowFixture } from './helpers/window-fixture.js';

function fixture(name = 'furnace', type = 'minecraft:furnace', size = 3) {
  const s = windowFixture(type, size, [{ name: 'dirt', count: 32, slot: 36 }, { name: 'book', count: 1, slot: 9 }, { name: 'iron_sword', count: 1, slot: 10 }]);
  const block = (name: string, position = new Vec3(0, 0, 0)) => ({ name, position, getProperties: () => ({}) }) as ReturnType<Bot['blockAt']>;
  let current = block(name);
  s.bot.blockAt = () => current;
  const activate = sinon.spy(s.bot, 'activateBlock');
  s.bot.getControlState = () => false;
  return { ...s, block, activate, setBlock: (name: string) => { current = block(name); }, unload: () => { current = null; } };
}

for (const name of ['birch_pressure_plate', 'dirt', 'air', 'oak_door', 'crafting_table', 'chest']) {
  test(`furnace preflight rejects ${name} without activating, spending held dirt or fencing`, async t => {
    const s = fixture(name);
    await t.throwsAsync(openWindowVerified(s.bot, s.bot.blockAt(new Vec3(0, 0, 0))!, { expectedTypes: FURNACE_WINDOW_TYPES }), { message: /current block/ });
    t.false(s.activate.called); t.is(s.writes.length, 0); t.is(s.authority.fence, null); t.is(s.authority.getFrame(0).slots[36]?.count, 32);
  });
}

test('a stale furnace object is checked against the current pressure plate', async t => {
  const s = fixture(); const remembered = s.bot.blockAt(new Vec3(0, 0, 0))!; s.setBlock('birch_pressure_plate');
  await t.throwsAsync(openWindowVerified(s.bot, remembered), { message: /birch_pressure_plate/ });
  t.false(s.activate.called); t.is(s.authority.fence, null);
});

test('a stale furnace object cannot open a replacement chest', async t => {
  const s = fixture(); const remembered = s.bot.blockAt(new Vec3(0, 0, 0))!; s.setBlock('chest');
  await t.throwsAsync(openWindowVerified(s.bot, remembered), { message: /current block is chest/ });
  t.false(s.activate.called); t.is(s.authority.fence, null);
});

test('unloaded, occluded, distant or sneaking preflight failures send no interaction and no fence', async t => {
  for (const reason of ['unloaded', 'occluded', 'distant', 'sneaking']) {
    const s = fixture(); const remembered = s.bot.blockAt(new Vec3(0, 0, 0))!;
    if (reason === 'unloaded') s.unload();
    if (reason === 'occluded') s.bot.canSeeBlock = () => false;
    if (reason === 'distant') s.bot.entity.position = new Vec3(9, 0, 0);
    if (reason === 'sneaking') s.bot.getControlState = () => true;
    await t.throwsAsync(openWindowVerified(s.bot, remembered));
    t.false(s.activate.called, reason); t.is(s.authority.fence, null, reason);
  }
});

for (const [name, type] of [['furnace', 'minecraft:furnace'], ['blast_furnace', 'minecraft:blast_furnace'], ['smoker', 'minecraft:smoker']]) {
  test(`fresh visible ${name} still opens with complete server contents`, async t => {
    const s = fixture(name, type);
    await openWindowVerified(s.bot, s.bot.blockAt(new Vec3(0, 0, 0))!, { expectedTypes: FURNACE_WINDOW_TYPES });
    t.true(s.activate.calledOnce); t.is(s.bot.currentWindow?.type, type); t.is(s.authority.fence, null);
  });
}

test('supported storage and workstation variants retain their exact menu mapping', t => {
  for (const [name, type] of [['white_shulker_box', 'minecraft:shulker_box'], ['shulker_box', 'minecraft:shulker_box'], ['barrel', 'minecraft:generic_9x3'], ['damaged_anvil', 'minecraft:anvil'], ['chipped_anvil', 'minecraft:anvil'], ['smithing_table', 'minecraft:smithing'], ['enchanting_table', 'minecraft:enchantment'], ['brewing_stand', 'minecraft:brewing_stand']]) {
    const s = fixture(name);
    t.is(validateWindowBlock(s.bot, s.bot.blockAt(new Vec3(0, 0, 0))!, [type]).name, name);
  }
  const s = fixture('crafting_table');
  t.throws(() => validateWindowBlock(s.bot, s.bot.blockAt(new Vec3(0, 0, 0))!, STORAGE_WINDOW_TYPES));
});

test('a post-submission replacement or missing server window remains fenced', async t => {
  const s = fixture(); s.activate.restore();
  let submissions = 0;
  s.bot.activateBlock = async () => { submissions++; s.setBlock('birch_pressure_plate'); };
  await t.throwsAsync(openWindowVerified(s.bot, s.bot.blockAt(new Vec3(0, 0, 0))!, { timeoutMs: 10 }), { message: /timed out|deadline/ });
  t.is(submissions, 1); t.truthy(s.authority.fence);
});

test.serial('all registered typed opening routes reject a pressure plate before native interaction', async t => {
  const s = fixture('birch_pressure_plate');
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: async () => ({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(server, connection);
  const native = sinon.stub().rejects(new Error('Native opening must not be called'));
  Object.assign(s.bot, { entities: {}, players: {}, openFurnace: native, experience: { level: 30 } });
  const complete = await registerCompleteControls({ server, factory, bot: s.bot, fixture: true, legacy: new Map(), markRead: () => {}, stateRoot: '/tmp/minecraft-window-preflight-fixture' });
  t.teardown(async () => { await complete.stop(); });
  for (const [name, extra] of [['open-furnace', {}], ['open_furnace', {}], ['open-container', {}], ['open_container', {}], ['open-workstation', {}], ['enchant_item', { item: 'book' }], ['anvil_combine', { itemOne: 'iron_sword', name: 'Sword' }]] as const) {
    const registration = (server.tool as sinon.SinonStub).getCalls().find(call => call.args[0] === name);
    t.truthy(registration, name);
    const result = await registration!.args[3]({ x: 0, y: 0, z: 0, ...extra });
    t.true(result.isError, name); t.regex(result.content[0].text, /current block is birch_pressure_plate/, name);
    t.false(s.activate.called, name); t.false(native.called, name); t.is(s.writes.length, 0, name); t.is(s.authority.fence, null, name);
  }
});
