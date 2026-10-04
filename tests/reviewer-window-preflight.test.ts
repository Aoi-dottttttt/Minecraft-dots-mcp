import test from 'ava';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { windowFixture } from './helpers/window-fixture.js';
import { openWindowVerified, validateWindowBlock } from '../src/verified-window-actions.js';
const block = (name: string): Block => ({ name, position: new Vec3(0, 0, 0), getProperties: () => ({}) }) as Block;

test('review: rejected stale target releases exclusive lane and permits a later valid opening without recovery', async t => {
  const s = windowFixture('minecraft:furnace', 3, [{ name: 'dirt', count: 32, slot: 36 }]);
  const remembered = block('furnace'); let current = block('birch_pressure_plate'); let activations = 0;
  s.bot.blockAt = () => current;
  s.bot.activateBlock = async () => { activations++; s.open(); };
  await t.throwsAsync(openWindowVerified(s.bot, remembered), { message: /birch_pressure_plate/ });
  t.is(activations, 0); t.is(s.authority.fence, null); t.is(s.writes.length, 0); t.is(s.authority.getFrame(0).slots[36]?.count, 32);
  current = block('furnace');
  await openWindowVerified(s.bot, remembered, { timeoutMs: 500 });
  t.is(activations, 1); t.is(s.authority.fence, null); t.is(s.authority.getFrame(0).slots[36]?.count, 32);
});

test('review: activation receives freshly reread object rather than remembered object', async t => {
  const s = windowFixture('minecraft:furnace', 3); const remembered = block('furnace'); const fresh = block('furnace');
  s.bot.blockAt = () => fresh; const activated: Block[] = [];
  s.bot.activateBlock = async target => { activated.push(target); s.open(); };
  t.is(validateWindowBlock(s.bot, remembered), fresh);
  await openWindowVerified(s.bot, remembered, { timeoutMs: 500 });
  t.is(activated[0], fresh); t.not(activated[0], remembered);
});

test('review: inferred furnace subtype cannot silently change to smoker and does not acquire a fence', async t => {
  const s = windowFixture('minecraft:smoker', 3); s.bot.blockAt = () => block('smoker'); let activations = 0;
  s.bot.activateBlock = async () => { activations++; s.open(); };
  await t.throwsAsync(openWindowVerified(s.bot, block('furnace')), { message: /current block is smoker/ });
  t.is(activations, 0); t.is(s.writes.length, 0); t.is(s.authority.fence, null);
});

test('review: bad coordinate and visibility preflight exceptions remain mutation-free', async t => {
  for (const reason of ['fractional', 'visibility-error']) {
    const s = windowFixture('minecraft:furnace', 3); const target = block('furnace'); let activations = 0;
    if (reason === 'fractional') target.position = new Vec3(0.5, 0, 0);
    else s.bot.canSeeBlock = () => { throw new Error('Visibility unavailable'); };
    s.bot.activateBlock = async () => { activations++; };
    await t.throwsAsync(openWindowVerified(s.bot, target));
    t.is(activations, 0, reason); t.is(s.writes.length, 0, reason); t.is(s.authority.fence, null, reason);
  }
});

test('review: wrong menu after submission still fences and never sends inventory clicks', async t => {
  const s = windowFixture('minecraft:generic_9x3', 27); s.bot.blockAt = (() => block('furnace')) as Bot['blockAt']; let activations = 0;
  s.bot.activateBlock = async () => { activations++; s.open(); };
  await t.throwsAsync(openWindowVerified(s.bot, block('furnace'), { timeoutMs: 500 }), { message: /Unexpected window type/ });
  t.is(activations, 1); t.truthy(s.authority.fence); t.is(s.writes.length, 0);
});
