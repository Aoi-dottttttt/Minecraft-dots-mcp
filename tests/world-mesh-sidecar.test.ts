import test from 'ava';
import { constants, openSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, chmod, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import minecraftData from 'minecraft-data';
import { createMeshFileSidecar, makeMeshFrame, OfficialMeshWorker, MESH_MAX_BYTES, MESH_MAX_VERTICES } from '../src/world-mesh-sidecar.js';
import type { WorldFileFrame } from '../src/world-file-export.js';
const data = minecraftData('1.21.1');
let worker: OfficialMeshWorker;
const center = (6 * 17 + 8) * 17 + 8;
function frame(y = 64): WorldFileFrame {
  const now = Date.now(), states = Array(3757).fill(0); states[center] = data.blocksByName.grass_block.defaultState;
  return { schemaVersion: 1, minecraftVersion: '1.21.1', generation: 1, sequence: 2, capturedAt: new Date(now).toISOString(), validUntil: new Date(now + 5000).toISOString(), status: 'live', reason: 'observed',
    position: { x: 8.5, y, z: 8.5 }, yaw: 0, pitch: 0, volume: { origin: { x: 0, y: y - 6, z: 0 }, size: { x: 17, y: 13, z: 17 }, order: 'y,z,x', stateIds: states, biomes: Array(3757).fill(data.biomesByName.plains.id), skyLight: Array(3757).fill(15), blockLight: Array(3757).fill(0) } };
}
test.before(() => { worker = new OfficialMeshWorker(); });

test.serial('mesh: official pinned worker returns original geometry and section offsets at supported heights', t => {
  for (const y of [-32, 64, 280]) {
    const result = makeMeshFrame(frame(y), worker);
    t.is(result.status, 'live', result.reason); t.true(result.bounded); t.is(result.unknownCells, 0);
    t.true(result.sections.length > 0);
    const vertices = result.sections.reduce((sum, section) => sum + section.positions.length / 3, 0);
    t.true(vertices > 0 && vertices <= MESH_MAX_VERTICES); t.true(Buffer.byteLength(JSON.stringify(result)) <= MESH_MAX_BYTES);
    for (const section of result.sections) {
      t.is(section.normals.length, section.positions.length); t.is(section.colors.length, section.positions.length);
      t.is(section.uvs.length * 3, section.positions.length * 2); t.true(section.indices.length > 0);
      t.is(section.offset[1], Math.floor(y / 16) * 16 + 8);
    }
  }
});

test.serial('mesh: unknown cells are marked, all-air frame clears old geometry and bounds remain explicit', t => {
  const source = frame(); source.volume!.stateIds[0] = null; source.volume!.biomes[0] = null; source.volume!.skyLight[0] = null;
  const result = makeMeshFrame(source, worker);
  t.is(result.status, 'live'); t.deepEqual(result.unknownIndices, [0]); t.is(result.unknownCells, 1); t.is(result.estimatedTintCells, 1); t.is(result.estimatedLightCells, 1);
  t.deepEqual(result.bounds, { origin: source.volume!.origin, size: source.volume!.size });
  const blank = frame(); blank.volume!.stateIds.fill(0);
  const cleared = makeMeshFrame(blank, worker); t.is(cleared.status, 'live'); t.deepEqual(cleared.sections, []);
});

test.serial('mesh: expired, malformed, unsupported height and stale source never retain geometry', t => {
  const expired = frame(); expired.capturedAt = new Date(Date.now() - 6000).toISOString(); expired.validUntil = new Date(Date.now() - 1000).toISOString();
  t.is(makeMeshFrame(expired, worker).reason, 'source-expired');
  for (const y of [-64, 319]) { const result = makeMeshFrame(frame(y), worker); t.is(result.reason, 'unsupported-height'); t.deepEqual(result.sections, []); }
  const invalid = frame(); invalid.volume!.stateIds[1] = 99999;
  t.is(makeMeshFrame(invalid, worker).reason, 'invalid-source');
  const leaked = makeMeshFrame({ ...frame(), chat: 'PRIVATE_TEST_TEXT' }, worker);
  t.is(leaked.reason, 'invalid-source'); t.false(JSON.stringify(leaked).includes('PRIVATE_TEST_TEXT'));
  const stale = frame(); stale.status = 'stale'; stale.reason = 'respawn'; stale.position = null; stale.yaw = null; stale.pitch = null; stale.volume = null; stale.validUntil = stale.capturedAt;
  const result = makeMeshFrame(stale, worker); t.is(result.reason, 'source-stale'); t.deepEqual(result.sections, []); t.is(result.position, null);
});

test.serial('mesh files: read-only source conversion, private atomic output, close clears and source is unchanged', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-file-test-')); t.teardown(() => rm(directory, { recursive: true, force: true }));
  const sidecar = await createMeshFileSidecar(directory); t.teardown(() => sidecar.close());
  const source = JSON.stringify(frame()); await writeFile(join(directory, 'world-frame.json'), source, { mode: 0o600 });
  const result = await sidecar.tick(); t.is(result.status, 'live', result.reason);
  const published = JSON.parse(await readFile(sidecar.path, 'utf8')); t.true(published.sections.length > 0); t.is(published.sourceSequence, 2);
  t.is(await readFile(join(directory, 'world-frame.json'), 'utf8'), source);
  await sidecar.close(); const closed = JSON.parse(await readFile(sidecar.path, 'utf8')); t.is(closed.status, 'stale'); t.deepEqual(closed.sections, []);
  t.deepEqual((await readdir(directory)).sort(), ['mesh-frame.json', 'world-frame.json']);
});

test.serial('mesh files: unsafe or unavailable source produces stale rather than reading symlink target', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-file-test-')); t.teardown(() => rm(directory, { recursive: true, force: true }));
  const sidecar = await createMeshFileSidecar(directory); t.teardown(() => sidecar.close());
  const elsewhere = join(directory, 'untouched'); await writeFile(elsewhere, JSON.stringify(frame()), { mode: 0o600 });
  await symlink(elsewhere, join(directory, 'world-frame.json'));
  const result = await sidecar.tick(); t.is(result.status, 'stale'); t.is(result.reason, 'source-unavailable');
  t.deepEqual(result.sections, []); await chmod(elsewhere, 0o600);
});

test.serial('mesh: geometry vertex cap rejects before copying excessive arrays', t => {
  const internal = worker as unknown as { allowedSections: Set<string>; accept(message: unknown): void };
  internal.allowedSections.add('1024,64,1024');
  t.throws(() => internal.accept({ type: 'geometry', key: '1024,64,1024', geometry: { positions: new Float32Array((MESH_MAX_VERTICES + 1) * 3) } }), { message: 'geometry-limit' });
  t.is(makeMeshFrame(frame(), worker).status, 'live', 'A failed geometry batch must not poison later frames');
});

test.serial('mesh files: stale source clears immediately even inside the geometry rate limit', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-file-test-')); t.teardown(() => rm(directory, { recursive: true, force: true }));
  const sidecar = await createMeshFileSidecar(directory); t.teardown(() => sidecar.close());
  const input = frame(); await writeFile(join(directory, 'world-frame.json'), JSON.stringify(input), { mode: 0o600 });
  t.is((await sidecar.tick()).status, 'live');
  input.status = 'stale'; input.reason = 'respawn'; input.generation++; input.position = null; input.yaw = null; input.pitch = null; input.volume = null; input.validUntil = input.capturedAt;
  await writeFile(join(directory, 'world-frame.json'), JSON.stringify(input), { mode: 0o600 });
  const output = await sidecar.tick(); t.is(output.status, 'stale'); t.is(output.sourceGeneration, 2); t.deepEqual(output.sections, []);
  t.is(JSON.parse(await readFile(sidecar.path, 'utf8')).status, 'stale');
});


test.serial('mesh files: a FIFO source fails stale without blocking tick or close', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-fifo-test-')); t.teardown(() => rm(directory, { recursive: true, force: true }));
  const sidecar = await createMeshFileSidecar(directory); t.teardown(() => sidecar.close());
  const source = join(directory, 'world-frame.json');
  execFileSync('mkfifo', ['-m', '600', source]);
  let rescuedBlockedOpen = false;
  // Rescue the pre-fix blocking reader so the failing regression itself never
  // strands a libuv thread or its teardown. This writer sends no frame data.
  const rescue = setTimeout(() => {
    rescuedBlockedOpen = true;
    const fd = openSync(source, constants.O_WRONLY | constants.O_NONBLOCK);
    closeSync(fd);
  }, 1000);
  try {
    const result = await sidecar.tick();
    await sidecar.close();
    t.false(rescuedBlockedOpen, 'Non-regular source must be rejected before waiting for a FIFO writer');
    t.is(result.status, 'stale'); t.is(result.reason, 'source-unavailable'); t.deepEqual(result.sections, []);
    t.is(JSON.parse(await readFile(sidecar.path, 'utf8')).reason, 'closed');
  } finally { clearTimeout(rescue); }
});
