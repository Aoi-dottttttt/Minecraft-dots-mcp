import test from 'ava';
import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';
import { windowFixture } from './helpers/window-fixture.js';
import { clickWindowVerified } from '../src/verified-window-actions.js';
import type { ServerItem } from '../src/inventory-authority.js';

const require = createRequire(import.meta.url);
const { createSerializer, createDeserializer } = require('minecraft-protocol');
const encoder = createSerializer({ state: 'play', isServer: true, version: '1.21.1' });
const decoder = createDeserializer({ state: 'play', isServer: false, version: '1.21.1' });
function cursor(s: ReturnType<typeof windowFixture>, stateId: number | undefined, windowId = 255, slot = -1) {
  const raw = s.authority.raw(s.item('coal', 3) as ServerItem);
  s.bot._client.emit('set_slot', { windowId, slot, stateId, item: raw });
}

test('protocol767 binary cursor correction advances only the active complete menu state ID', t => {
  const s = windowFixture('minecraft:furnace', 3); s.open();
  const playerState = s.authority.getFrame(0).stateId;
  const data = encoder.createPacketBuffer({ name: 'set_slot', params: { windowId: 255, stateId: 54, slot: -1, item: s.authority.raw(s.item('coal', 3) as ServerItem) } });
  const decoded = decoder.parsePacketBuffer(data).data;
  s.bot._client.emit(decoded.name, decoded.params);
  t.is(s.authority.getFrame(7).stateId, 54); t.is(s.authority.getFrame(0).stateId, playerState);
  t.is(s.authority.cursor?.count, 3); t.is(s.authority.fence, null);
});

test('signed special cursor IDs update active menu and correctly wrap32767 to0', t => {
  const s = windowFixture('minecraft:furnace', 3); s.open();
  cursor(s, 32767, -1); t.is(s.authority.getFrame(7).stateId, 32767);
  cursor(s, 0, -1); t.is(s.authority.getFrame(7).stateId, 0);
});

test('missing or negative cursor state IDs do not erase an active menu revision', t => {
  const s = windowFixture('minecraft:furnace', 3); s.open(); const before = s.authority.getFrame(7).stateId;
  for (const stateId of [undefined, -1, NaN, 1.5, 32768]) { cursor(s, stateId); t.is(s.authority.getFrame(7).stateId, before); }
  t.is(s.authority.cursor?.count, 3);
});

test('unassociated or pre-open cursor corrections never invent a complete menu', t => {
  const s = windowFixture('minecraft:furnace', 3); const original = s.authority.getFrame(0).stateId;
  cursor(s, 54); t.is(s.authority.getFrame(0).stateId, original); t.false(s.authority.frames.has(7));
  s.bot.currentWindow = s.native;
  cursor(s, 55); t.false(s.authority.frames.has(7));
  s.bot._client.emit('set_slot', { windowId: 7, slot: 0, stateId: 12, item: s.authority.raw(null) });
  cursor(s, 56); t.is(s.authority.frames.get(7)?.stateId, 12); t.is(s.authority.frames.get(7)?.fullRevision, 0);
});

test('tail cursor after local close does not apply its old menu revision to player inventory', async t => {
  const s = windowFixture('minecraft:furnace', 3); s.open(); const playerState = s.authority.getFrame(0).stateId;
  await s.bot.closeWindow(s.native); cursor(s, 80);
  t.is(s.authority.getFrame(0).stateId, playerState); t.not(s.authority.getFrame(7).stateId, 80);
});

test('a normal other-window slot correction cannot advance the active menu state', t => {
  const s = windowFixture('minecraft:furnace', 3); s.open(); const before = s.authority.getFrame(7).stateId;
  s.bot._client.emit('set_slot', { windowId: 8, slot: 0, stateId: 90, item: s.authority.raw(s.item('coal', 1) as ServerItem) });
  t.is(s.authority.getFrame(7).stateId, before); t.is(s.authority.cursor, null);
});

test('cursor state tracking cannot clear an existing fence', t => {
  const s = windowFixture('minecraft:furnace', 3); s.open(); s.authority.block('Unconfirmed prior click');
  cursor(s, 90); t.is(s.authority.fence, 'Unconfirmed prior click');
});

test('the cursor-state association is limited to verified protocol767', t => {
  const s = windowFixture('minecraft:furnace', 3); s.open(); const before = s.authority.getFrame(7).stateId;
  Object.assign(s.bot, { registry: { ...s.bot.registry, version: { ...s.bot.registry.version, version: 768 } } });
  cursor(s, 90, -1); t.is(s.authority.getFrame(7).stateId, before); t.is(s.authority.cursor?.count, 3);
});

test('sequential menu clicks use latest distinct slot and cursor state IDs without resync', async t => {
  const s = windowFixture('minecraft:furnace', 3); s.open();
  const writes: Array<{ stateId: number; slot: number }> = [];
  let expectedState = s.authority.getFrame(7).stateId;
  const wire = (windowId: number, slot: number, item: ReturnType<typeof s.item> | null) => {
    const bytes = encoder.createPacketBuffer({ name: 'set_slot', params: { windowId, stateId: ++expectedState, slot, item: s.authority.raw(item as ServerItem | null) } });
    const decoded = decoder.parsePacketBuffer(bytes).data; s.bot._client.emit(decoded.name, decoded.params);
  };
  s.bot._client.write = ((_name: string, raw: unknown) => {
    const packet = raw as { stateId: number; slot: number };
    if (packet.stateId !== expectedState) throw new Error(`Stale click state ${packet.stateId}; expected ${expectedState}`);
    writes.push(packet);
    if (packet.slot === 3) { wire(7, 3, null); wire(255, -1, s.item('coal', 4)); }
    else { wire(7, 1, s.item('coal', 4)); wire(255, -1, null); }
  }) as Bot['_client']['write'];
  await clickWindowVerified(s.bot, { slot: 3, timeoutMs: 100 });
  await clickWindowVerified(s.bot, { slot: 1, timeoutMs: 100 });
  t.deepEqual(writes.map(p => p.stateId), [1, 3]); t.is(s.authority.getFrame(7).stateId, 5); t.is(s.authority.cursor, null); t.is(s.authority.fence, null);
});
