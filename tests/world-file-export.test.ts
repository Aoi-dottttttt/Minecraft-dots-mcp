import test from 'ava';
import { EventEmitter } from 'node:events';
import { watch } from 'node:fs';
import { mkdtemp, readFile, rm, stat, mkdir, writeFile, symlink, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { createWorldFileExporter, captureWorldVolume, WORLD_FILE_MAX_BYTES } from '../src/world-file-export.js';

function fixture() {
  const registry = minecraftData('1.21.1'); let reads = 0;
  const bot = Object.assign(new EventEmitter(), { version: '1.21.1', registry,
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0.25, pitch: -0.5 },
    blockAt: () => { reads++; return { stateId: registry.blocksByName.stone.defaultState, biome: { id: 1 }, skyLight: 15, light: 3, nbt: { secret: 'PRIVATE_TEST_TEXT' }, entities: ['PRIVATE_TEST_TEXT'] }; },
    chat() { throw Error('No game actions'); }, findBlocks() { throw Error('No new chunks'); },
  }) as unknown as Bot;
  return { bot, reads: () => reads };
}

test('world file: capture has exactly 3757 sanitized cells and no text/entity payload', t => {
  const f = fixture(); const frame = captureWorldVolume(f.bot);
  t.is(f.reads(), 3757); t.is(frame.volume.stateIds.length, 3757);
  t.deepEqual(frame.volume.size, { x: 17, y: 13, z: 17 });
  t.deepEqual(frame.volume.origin, { x: -8, y: 58, z: -8 });
  t.false(JSON.stringify(frame).includes('PRIVATE_TEST_TEXT'));
});

test.serial('world file: private atomic file becomes empty stale on respawn and close', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'world-file-test-')); t.teardown(() => rm(parent, { recursive: true, force: true }));
  const f = fixture(); const exporter = await createWorldFileExporter(f.bot, { directory: join(parent, 'out'), initiallyReady: true });
  t.teardown(() => exporter.close());
  const live = JSON.parse(await readFile(exporter.path, 'utf8')); t.is(live.status, 'live');
  t.is((await stat(exporter.path)).mode & 0o777, 0o600); t.is((await stat(join(parent, 'out'))).mode & 0o777, 0o700);
  f.bot.emit('respawn'); await exporter.flush();
  const stale = JSON.parse(await readFile(exporter.path, 'utf8')); t.is(stale.status, 'stale'); t.is(stale.reason, 'respawn'); t.is(stale.volume, null); t.is(stale.position, null);
  await exporter.close();
  const closed = JSON.parse(await readFile(exporter.path, 'utf8')); t.is(closed.status, 'stale'); t.is(closed.reason, 'closed');
  t.is(f.bot.listenerCount('spawn'), 0); t.is(f.bot.listenerCount('respawn'), 0); t.is(f.bot.listenerCount('end'), 0);
});

test('world file: unloaded or invalid block/biome/light data is null, never invented air', t => {
  const f = fixture();
  f.bot.blockAt = (() => null) as Bot['blockAt'];
  const missing = captureWorldVolume(f.bot);
  t.true(missing.volume.stateIds.every(value => value === null));
  f.bot.blockAt = (() => ({ stateId: 99999, biome: { id: 65535 }, light: 16, skyLight: NaN })) as unknown as Bot['blockAt'];
  const invalid = captureWorldVolume(f.bot);
  for (const field of ['stateIds', 'biomes', 'blockLight', 'skyLight'] as const) t.true(invalid.volume[field].every(value => value === null));
  t.true(Buffer.byteLength(JSON.stringify(invalid)) < WORLD_FILE_MAX_BYTES);
});

test('world file: nonfinite or out-of-range player observation rejects before reading any cell', t => {
  for (const bad of [NaN, Infinity, 30000000]) {
    const f = fixture(); f.bot.entity.position.x = bad;
    t.throws(() => captureWorldVolume(f.bot)); t.is(f.reads(), 0);
  }
  for (const angle of ['yaw', 'pitch'] as const) {
    const f = fixture(); f.bot.entity[angle] = Infinity;
    t.throws(() => captureWorldVolume(f.bot)); t.is(f.reads(), 0);
  }
});

test.serial('world file: startup waits for spawn; 2-second cadence and generation isolate fresh dimensions', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'world-file-test-')); t.teardown(() => rm(parent, { recursive: true, force: true }));
  const f = fixture(); const exporter = await createWorldFileExporter(f.bot, { directory: join(parent, 'out') }); t.teardown(() => exporter.close());
  t.is(f.reads(), 0); t.false(await exporter.sample());
  f.bot.emit('spawn'); await exporter.flush();
  const first = JSON.parse(await readFile(exporter.path, 'utf8')); t.is(first.status, 'live'); t.is(f.reads(), 3757);
  for (let i = 0; i < 10; i++) t.false(await exporter.sample());
  t.is(f.reads(), 3757); t.is(Date.parse(first.validUntil) - Date.parse(first.capturedAt), 5000);
  f.bot.emit('respawn'); await exporter.flush();
  const stale = JSON.parse(await readFile(exporter.path, 'utf8')); t.is(stale.volume, null); t.true(stale.generation > first.generation);
  const oldRead = f.bot.blockAt.bind(f.bot); const newState = f.bot.registry.blocksByName.dirt.defaultState;
  f.bot.blockAt = ((...args: Parameters<Bot['blockAt']>) => ({ ...oldRead(...args), stateId: newState })) as Bot['blockAt'];
  f.bot.emit('spawn'); await exporter.flush();
  t.is(JSON.parse(await readFile(exporter.path, 'utf8')).status, 'stale', 'New spawn cannot bypass sampling cadence');
  await new Promise(resolve => setTimeout(resolve, 2100)); await exporter.sample(); await exporter.flush();
  const fresh = JSON.parse(await readFile(exporter.path, 'utf8'));
  t.is(fresh.status, 'live'); t.is(fresh.generation, stale.generation); t.true(fresh.volume.stateIds.every((id: number) => id === newState));
});

test.serial('world file: close during a real in-flight write wins and leaves no temporary file', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'world-file-test-')); t.teardown(() => rm(parent, { recursive: true, force: true }));
  const f = fixture(), directory = join(parent, 'out');
  const exporter = await createWorldFileExporter(f.bot, { directory }); t.teardown(() => exporter.close());
  let closePromise: Promise<void> | undefined;
  const interrupted = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Fixture did not observe temporary write')), 3000);
    const watcher = watch(directory, (_event, filename) => {
      if (!filename?.endsWith('.tmp')) return;
      watcher.close(); clearTimeout(timeout);
      f.bot.emit('respawn'); closePromise = exporter.close(); resolve();
    });
    t.teardown(() => { watcher.close(); clearTimeout(timeout); });
  });
  f.bot.emit('spawn'); await interrupted; await closePromise;
  const final = JSON.parse(await readFile(exporter.path, 'utf8'));
  t.is(final.status, 'stale'); t.is(final.reason, 'closed'); t.is(final.volume, null); t.is(final.position, null);
  t.deepEqual(await readdir(directory), ['world-frame.json']);
  f.bot.emit('spawn'); f.bot.emit('respawn'); await exporter.flush();
  t.is(JSON.parse(await readFile(exporter.path, 'utf8')).reason, 'closed');
});

test.serial('world file: repeated reset is coalesced; disconnect clears and cannot reconnect itself', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'world-file-test-')); t.teardown(() => rm(parent, { recursive: true, force: true }));
  const f = fixture(); const exporter = await createWorldFileExporter(f.bot, { directory: join(parent, 'out'), initiallyReady: true }); t.teardown(() => exporter.close());
  for (let i = 0; i < 100; i++) f.bot.emit('respawn');
  f.bot.emit('end', 'PRIVATE_TEST_TEXT'); await exporter.flush();
  const disconnected = JSON.parse(await readFile(exporter.path, 'utf8'));
  t.is(disconnected.reason, 'disconnected'); t.is(disconnected.generation, 101); t.is(disconnected.volume, null);
  t.false(JSON.stringify(disconnected).includes('PRIVATE_TEST_TEXT')); t.is(f.bot.listenerCount('spawn'), 0);
  f.bot.emit('spawn'); t.false(await exporter.sample()); t.is(f.reads(), 3757);
});

test.serial('world file: symlink paths and nonprivate destinations reject without reading or replacing contents', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'world-file-test-')); t.teardown(() => rm(parent, { recursive: true, force: true }));
  const directory = join(parent, 'out'), secret = join(parent, 'secret');
  await mkdir(directory, { mode: 0o700 }); await writeFile(secret, 'DO_NOT_TOUCH', { mode: 0o600 });
  await symlink(directory, join(parent, 'alias'));
  const f = fixture();
  await t.throwsAsync(createWorldFileExporter(f.bot, { directory: join(parent, 'alias') }), { message: /symlinks/ });
  await symlink(secret, join(directory, 'world-frame.json'));
  await t.throwsAsync(createWorldFileExporter(f.bot, { directory }), { message: /private regular file/ });
  t.is(await readFile(secret, 'utf8'), 'DO_NOT_TOUCH'); t.is(f.reads(), 0);
  await rm(join(directory, 'world-frame.json')); await writeFile(join(directory, 'world-frame.json'), 'DO_NOT_TOUCH', { mode: 0o644 });
  await t.throwsAsync(createWorldFileExporter(f.bot, { directory }), { message: /permissions/ });
  t.is(await readFile(join(directory, 'world-frame.json'), 'utf8'), 'DO_NOT_TOUCH');
});

test.serial('world file: observation failure clears prior data and never exports error text', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'world-file-test-')); t.teardown(() => rm(parent, { recursive: true, force: true }));
  const f = fixture(); f.bot.blockAt = (() => { throw Error('PRIVATE_TEST_TEXT'); }) as Bot['blockAt'];
  const exporter = await createWorldFileExporter(f.bot, { directory: join(parent, 'out'), initiallyReady: true }); t.teardown(() => exporter.close());
  const content = await readFile(exporter.path, 'utf8'), value = JSON.parse(content);
  t.is(value.status, 'stale'); t.is(value.reason, 'invalid-observation'); t.is(value.volume, null); t.false(content.includes('PRIVATE_TEST_TEXT'));
});

test.serial('world file: write failure is observable and pauses sampling rather than claiming a clear succeeded', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'world-file-test-')); t.teardown(() => rm(parent, { recursive: true, force: true }));
  const f = fixture(); const exporter = await createWorldFileExporter(f.bot, { directory: join(parent, 'out'), initiallyReady: true });
  await chmod(exporter.path, 0o644);
  f.bot.emit('respawn'); await t.throwsAsync(exporter.flush(), { message: /permissions/ });
  t.is(exporter.getError(), 'world-file-write-failed'); t.false(await exporter.sample());
  await chmod(exporter.path, 0o600); await exporter.close();
  t.is(JSON.parse(await readFile(exporter.path, 'utf8')).reason, 'closed');
});
