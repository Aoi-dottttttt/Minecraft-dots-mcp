import test from 'ava';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';
import { installOxygenAuthority, readOxygenEvidence } from '../src/oxygen-authority.js';
import { moveAndVerify } from '../src/tools/movement-utils.js';

const require = createRequire(import.meta.url);
/** The actual pinned entities plugin, with an EventEmitter protocol client.
 * No createBot, sockets, server, account or credentials are involved. */
function fixture() {
  const registry = require('prismarine-registry')('1.21.1');
  const bot = Object.assign(new EventEmitter(), {
    version: '1.21.1', registry, supportFeature: registry.supportFeature,
    _client: Object.assign(new EventEmitter(), { username: 'FixtureBot' }), game: { dimension: 'overworld' }
  }) as unknown as Bot;
  require('mineflayer/lib/plugins/entities')(bot);
  bot._client.emit('login', { entityId: 7 });
  bot._client.emit('spawn_entity', { entityId: 42, type: registry.entitiesByName.axolotl.id,
    x: 1, y: 64, z: 1, yaw: 0, pitch: 0, headPitch: 0, objectData: 0, velocity: { x: 0, y: 0, z: 0 } });
  const air = (entityId: number, value: number) => bot._client.emit('entity_metadata', { entityId, metadata: [{ key: 1, type: 'int', value }] });
  return { bot, air };
}

test('pinned native regression: another entity can overwrite bot oxygen and emit breath', t => {
  const { bot, air } = fixture(); let breaths = 0; bot.on('breath', () => { breaths++; });
  air(7, 75); t.is(bot.oxygenLevel, 5);
  air(42, 4680); t.is(bot.oxygenLevel, 312); t.is(breaths, 2);
});

test('own authority rejects nearby and local pollution, including plausible full-air values', t => {
  const { bot, air } = fixture(); air(42, 4680);
  const authority = installOxygenAuthority(bot);
  t.false(authority.snapshot().known); t.true(Number.isNaN(bot.oxygenLevel));
  let ownUpdates = 0; authority.on('change', () => { ownUpdates++; });
  air(7, 75); const own = authority.snapshot(); t.is(bot.oxygenLevel, 5);
  for (const value of [4680, 300, 0]) air(42, value);
  bot.oxygenLevel = 20; bot.emit('breath');
  t.is(authority.snapshot().observedAt, own.observedAt); t.is(authority.snapshot().rawAirSupply, own.rawAirSupply);
  t.is(authority.snapshot().revision, own.revision); t.is(bot.oxygenLevel, 5); t.is(ownUpdates, 1);
  air(7, 300); t.is(bot.oxygenLevel, 20); t.is(authority.snapshot().rawAirSupply, 300);
  t.is(authority.snapshot().entityId, 7); t.is(ownUpdates, 2);
});

test('own values are not clamped to hide their origin and negative air stays observable', t => {
  const { bot, air } = fixture(); const authority = installOxygenAuthority(bot);
  air(7, 4680); t.is(bot.oxygenLevel, 312); t.is(authority.snapshot().rawAirSupply, 4680);
  air(7, -20); t.is(bot.oxygenLevel, -1); t.is(authority.snapshot().rawAirSupply, -20);
});

test('identity, dimension, death, respawn and end invalidate old samples', t => {
  const { bot, air } = fixture(); const authority = installOxygenAuthority(bot);
  air(7, 300); t.true(authority.snapshot().known);
  bot.game.dimension = 'the_nether'; t.false(authority.snapshot().known);
  air(7, 150); t.is(authority.snapshot().oxygen, 10);
  bot.emit('death'); t.false(authority.snapshot().known);
  air(7, 300); t.false(authority.snapshot().known);
  bot._client.emit('respawn', {}); t.false(authority.snapshot().known);
  air(7, 300); t.true(authority.snapshot().known);
  bot._client.emit('login', { entityId: 8 }); t.false(authority.snapshot().known);
  air(7, 300); t.false(authority.snapshot().known);
  air(8, 60); t.is(authority.snapshot().oxygen, 4);
  bot.emit('end', 'neutral fixture'); t.false(authority.snapshot().known);
  air(8, 300); t.false(authority.snapshot().known); t.true(Number.isNaN(bot.oxygenLevel));
});

test('duplicate or malformed own air cannot retain a previously good confirmation', t => {
  const { bot, air } = fixture(); const authority = installOxygenAuthority(bot);
  for (const metadata of [
    [{ key: 1, type: 'int', value: 300 }, { key: 1, type: 'int', value: 0 }],
    [{ key: 1, type: 'int', value: Number.NaN }],
    [{ key: 1, type: 'float', value: 300 }]
  ]) {
    air(7, 300); const previous = authority.snapshot().revision;
    bot._client.emit('entity_metadata', { entityId: 7, metadata });
    t.false(authority.snapshot().known); t.true(authority.snapshot().revision > previous);
  }
});

test('installation is idempotent and missing authority never trusts a native cache', t => {
  const { bot, air } = fixture(); air(7, 300);
  t.false(readOxygenEvidence(bot).known);
  const authority = installOxygenAuthority(bot); const listeners = bot._client.listenerCount('entity_metadata');
  t.is(installOxygenAuthority(bot), authority); t.is(bot._client.listenerCount('entity_metadata'), listeners);
  t.false(authority.snapshot().known);
});

test('actual native other-entity low air does not abort a dry route, but own low air does', async t => {
  const { bot, air } = fixture(); const oxygen = installOxygenAuthority(bot); air(7, 300);
  let stopped = 0; let rejectPath: (error: Error) => void = () => {};
  Object.assign(bot, { health: 20, blockAt: () => null, clearControlStates: () => {},
    pathfinder: { movements: undefined,
      goto: () => new Promise<void>((_resolve, reject) => { rejectPath = reject; }),
      setGoal: () => { stopped++; rejectPath(new Error('goal changed')); }
    }
  });
  const before = oxygen.snapshot().revision;
  const action = moveAndVerify(bot, { isEnd: () => false } as never, 1000);
  const assertion = t.throwsAsync(action, { message: /Low oxygen/ });
  await new Promise(resolve => setImmediate(resolve));
  air(42, 0); await new Promise(resolve => setImmediate(resolve));
  t.is(stopped, 0); t.is(bot.oxygenLevel, 20); t.is(oxygen.snapshot().revision, before);
  air(7, 75); await assertion;
  t.is(stopped, 1); t.is(bot.oxygenLevel, 5); t.is(oxygen.listenerCount('change'), 0);
});

test('protocol 767 encoded metadata retains exact self identity and int air type', t => {
  const protocol = require('minecraft-protocol');
  const serializer = protocol.createSerializer({ state: protocol.states.PLAY, isServer: true, version: '1.21.1' });
  const deserializer = protocol.createDeserializer({ state: protocol.states.PLAY, isServer: false, version: '1.21.1' });
  const { bot } = fixture(); const authority = installOxygenAuthority(bot);
  for (const [entityId, value] of [[7, 90], [42, 4680]]) {
    const encoded = serializer.createPacketBuffer({ name: 'entity_metadata', params: { entityId, metadata: [{ key: 1, type: 'int', value }] } });
    const decoded = deserializer.parsePacketBuffer(encoded).data;
    bot._client.emit(decoded.name, decoded.params);
    t.is(authority.snapshot().oxygen, 6); t.is(authority.snapshot().entityId, 7);
  }
});
