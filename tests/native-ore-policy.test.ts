// Modified for 2.1.0-dot.2 release (2026-10-03). See RELEASE.md.
// Runs the actual native wrapper's policy offline; no bot, socket, or credentials.
import test from 'ava';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';

const source = readFileSync(new URL('../runtime/minecraft-server.mjs', import.meta.url), 'utf8');
const baseline = readFileSync(new URL('./fixtures/natural-dig-policy-dot1.txt', import.meta.url), 'utf8');
const additions = ['gold_ore', 'deepslate_gold_ore', 'redstone_ore', 'deepslate_redstone_ore', 'diamond_ore', 'deepslate_diamond_ore','wheat','carrots','potatoes','beetroots','nether_wart','cocoa','melon','pumpkin','bamboo','cactus','kelp','kelp_plant'];
const regexFromDeclaration = (text: string) => {
  const match = text.match(/^const natural=\/([^\n]+)\/;$/m);
  if (!match) throw new Error('Native natural-block policy declaration was not found');
  return new RegExp(match[1]);
};
const current = regexFromDeclaration(source);
const previous = regexFromDeclaration(baseline);
type Args = { x: number; y: number; z: number };
type Response = { content: Array<{ type: string; text: string }>; isError?: boolean };
function guard(name: string | null, position = new Vec3(0.5, 64, 0.5)) {
  const registered = new Map<string, (args: Args) => Promise<Response>>();
  const ownBlocks = new Map<string, string>();
  let executed = 0;
  const response = (text: string) => ({ content: [{ type: 'text', text }] });
  const start = source.indexOf('const natural=');
  const end = source.indexOf('for(const register of', start);
  if (start < 0 || end < 0) throw new Error('Native wrapper boundaries changed; fixture needs review');
  const wrapped = runInNewContext(source.slice(start, end) + '\nwrapped;', {
    Vec3, ownBlocks: { has: (point: Vec3) => ownBlocks.get(point.toString()) === name, forget: (point: Vec3) => ownBlocks.delete(point.toString()) },
    // This fixture isolates the native block policy; cancellation and the real
    // shared action context are exercised by review-capability-gaps.test.ts.
    readTools: new Set(), complete: { runAction: async (operation: () => Promise<Response>) => operation() },
    bot: { entity: { position }, blockAt: () => name === null ? null : { name } },
    factory: { createResponse: response, createErrorResponse: response, registerTool(tool: string, _description: string, _schema: object, executor: (args: Args) => Promise<Response>) { registered.set(tool, executor); } }
  }, { timeout: 1000 }) as { registerTool(tool: string, description: string, schema: object, executor: (args: Args) => Promise<Response>): void };
  wrapped.registerTool('dig-block', 'Offline policy fixture', {}, async () => { executed++; return response(`Dug ${name}`); });
  return { call: registered.get('dig-block')!, executed: () => executed, ownBlocks };
}
const target = { x: 1, y: 64, z: 0 };

test('native policy adds only the enumerated ore and crop names across the complete 1.21.1 block registry', t => {
  const names = minecraftData('1.21.1').blocksArray.map(block => block.name);
  t.deepEqual(names.filter(name => current.test(name) && !previous.test(name)).sort(), [...additions].sort());
  t.deepEqual(names.filter(name => previous.test(name) && !current.test(name)), []);
  t.false(current.test('deepslate_copper_ore'));
  for (const name of additions) { t.true(names.includes(name)); t.false(current.test(`${name}_extra`)); t.false(current.test(`prefix_${name}`)); }
});
for (const name of additions) {
  test(`native policy allows ordinary mining of ${name} without inventing ownership`, async t => {
    const s = guard(name); await s.call(target);
    t.is(s.executed(), 1); t.is(s.ownBlocks.size, 0);
  });
}
test('native policy keeps constructed and storage blocks protected', async t => {
  for (const name of ['chest', 'barrel', 'furnace', 'oak_planks', 'stone_bricks', 'gold_block', 'redstone_block', 'diamond_block']) {
    const s = guard(name); await t.throwsAsync(s.call(target), { message: /Protected constructed block/ });
    t.is(s.executed(), 0); t.is(s.ownBlocks.size, 0);
  }
});
test('native ore permission never overrides reach restriction', async t => {
  for (const name of additions) {
    const s = guard(name); await t.throwsAsync(s.call({ x: 8, y: 64, z: 0 }), { message: /within reach/ });
    t.is(s.executed(), 0); t.is(s.ownBlocks.size, 0);
  }
});
test('native ore permission never overrides support-underfoot restriction', async t => {
  for (const name of additions) {
    const s = guard(name); await t.throwsAsync(s.call({ x: 0, y: 63, z: 0 }), { message: /support beneath feet/ });
    t.is(s.executed(), 0); t.is(s.ownBlocks.size, 0);
  }
});
test('native policy preserves existing legitimate ownership behavior', async t => {
  const s = guard('oak_planks'); s.ownBlocks.set(new Vec3(target.x, target.y, target.z).toString(), 'oak_planks');
  await s.call(target); t.is(s.executed(), 1); t.is(s.ownBlocks.size, 1);
});
test('native policy still rejects unknown terrain before executing', async t => {
  const s = guard(null); await t.throwsAsync(s.call(target), { message: /Unknown block/ }); t.is(s.executed(), 0);
});
