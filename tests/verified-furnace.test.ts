// Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
import test from 'ava';
import sinon from 'sinon';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import { ToolFactory } from '../src/tool-factory.js';
import { registerFurnaceTools } from '../src/tools/furnace-tools.js';
import { windowFixture } from './helpers/window-fixture.js';
function fixture(rejectOutput = false, generateOutput = true) {
  const s = windowFixture('minecraft:furnace', 3, [{ name: 'iron_ore', count: 3, slot: 9 }, { name: 'coal', count: 2, slot: 10 }]);
  const close = sinon.spy(s.bot, 'closeWindow');
  const write = s.bot._client.write.bind(s.bot._client);
  s.bot._client.write = ((name: string, raw: unknown) => {
    if (rejectOutput && name === 'window_click' && (raw as {slot: number}).slot === 2) s.settings.reject = true;
    write(name, raw);
  }) as typeof s.bot._client.write;
  let generated = false;
  s.settings.onClick = slot => {
    if (slot === 0 && s.slots[0] && generateOutput && !generated) {
      generated = true;
      setImmediate(() => { s.slots[0] = null; s.slots[2] = s.item('iron_ingot', 1); s.sync(); });
    }
  };
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: async () => ({ connected: true }) } as unknown as BotConnection;
  registerFurnaceTools(new ToolFactory(server, connection), () => s.bot);
  const call = (server.tool as sinon.SinonStub).firstCall.args[3];
  return { ...s, close, call };
}
const args = { x: 0, y: 0, z: 0, inputItem: 'iron_ore', fuelItem: 'coal' };
test('furnace confirms deposits and collected inventory output', async t => {
  const s = fixture(); const result = await s.call(args);
  t.false(!!result.isError); t.regex(result.content[0].text, /Server-confirmed collection: 1 iron_ingot/);
  t.is(s.authority.count(s.bot.registry.itemsByName.iron_ingot.id), 1); t.is(s.authority.fence, null);
  t.true(s.close.calledOnce);
});
test('furnace pending output reports retained materials without duplicating deposits', async t => {
  const s = fixture(false, false); const result = await s.call({ ...args, timeoutMs: 50 });
  t.false(!!result.isError); t.regex(result.content[0].text, /Materials remain in the furnace/); t.is(s.authority.fence, null);
});
test('furnace optimistic output pickup cannot report success', async t => {
  const s = fixture(true); const result = await s.call(args);
  t.true(!!result.isError); t.truthy(s.authority.fence);
  t.is(s.authority.count(s.bot.registry.itemsByName.iron_ingot.id), 0);
  t.false(s.close.called);
});

test('furnace rejects one stack counted as both input and fuel before opening', async t => {
  const s = fixture(); const open = sinon.spy(s.bot, 'activateBlock');
  const result = await s.call({ ...args, inputItem: 'coal', inputCount: 2, fuelItem: 'coal', fuelCount: 1 });
  t.true(!!result.isError); t.regex(result.content[0].text, /combined/); t.false(open.called);
  t.is(s.authority.count(s.bot.registry.itemsByName.coal.id), 2);
});
test('furnace never silently reduces requested counts', async t => {
  const s = fixture(); const open = sinon.spy(s.bot, 'activateBlock');
  const result = await s.call({ ...args, inputCount: 4 });
  t.true(!!result.isError); t.false(open.called); t.is(s.authority.count(s.bot.registry.itemsByName.iron_ore.id), 3);
});
