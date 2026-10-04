// Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
import test from 'ava';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import { withServerBlockConfirmation } from '../src/tools/block-confirmation.js';

function botFixture() {
  return Object.assign(new EventEmitter(), { _client: new EventEmitter() });
}

test('raw block confirmation ignores optimistic local blockUpdate events', async t => {
  const bot = botFixture();
  await t.throwsAsync(withServerBlockConfirmation(bot as unknown as Bot, new Vec3(2, 64, 0), state => state === 0, async () => {
    bot.emit('blockUpdate:2, 64, 0', { type: 1 }, { type: 0 });
  }, 10), { message: /not confirmed/ });
  t.is(bot._client.listenerCount('block_change'), 0);
  t.is(bot._client.listenerCount('multi_block_change'), 0);
});

test('raw single-block update confirms only the target and expected state', async t => {
  const bot = botFixture();
  await withServerBlockConfirmation(bot as unknown as Bot, new Vec3(2, 64, 0), state => state === 7, async () => {
    bot._client.emit('block_change', { location: { x: 2, y: 64, z: 0 }, type: 7 });
  }, 10);
  t.is(bot._client.listenerCount('block_change'), 0);
});

test('raw multi-block update decodes negative chunk coordinates and local cells', async t => {
  const bot = botFixture();
  await withServerBlockConfirmation(bot as unknown as Bot, new Vec3(-1, 64, 33), state => state === 7, async () => {
    bot._client.emit('multi_block_change', { chunkCoordinates: { x: -1, y: 4, z: 2 }, records: [(7 << 12) | (15 << 8) | (1 << 4)] });
  }, 10);
  t.is(bot._client.listenerCount('multi_block_change'), 0);
});

test('server correction back to old state prevents a false successful block action', async t => {
  const bot = botFixture();
  await t.throwsAsync(withServerBlockConfirmation(bot as unknown as Bot, new Vec3(2, 64, 0), state => state === 0, async () => {
    bot._client.emit('block_change', { location: { x: 2, y: 64, z: 0 }, type: 0 });
    bot._client.emit('block_change', { location: { x: 2, y: 64, z: 0 }, type: 1 });
  }, 10), { message: /not confirmed/ });
});

test('a failed block action cleans raw packet listeners and is never retried', async t => {
  const bot = botFixture();
  let attempts = 0;
  await t.throwsAsync(withServerBlockConfirmation(bot as unknown as Bot, new Vec3(2, 64, 0), state => state === 0, async () => {
    attempts++;
    throw new Error('rejected placement');
  }, 10), { message: 'rejected placement' });
  t.is(attempts, 1);
  t.is(bot._client.listenerCount('block_change'), 0);
  t.is(bot.listenerCount('end'), 0);
});
