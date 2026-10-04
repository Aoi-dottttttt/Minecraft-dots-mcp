import test from 'ava';
import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import minecraftData from 'minecraft-data';
import { installInteractionTrace } from '../src/interaction-trace.js';

function fixture() {
  const sent: string[] = [];
  const client = Object.assign(new EventEmitter(), { write: (name: string, _payload: unknown) => { sent.push(name); void _payload; } });
  const bot = Object.assign(new EventEmitter(), { _client: client }) as unknown as Bot;
  return { bot, client, sent, trace: installInteractionTrace(bot) };
}
test('protocol 767 digging acknowledgement trace uses the schema sequenceId field', t => {
  const data = minecraftData('1.21.1');
  t.is(data.version.version, 767);
  t.deepEqual(data.protocol.play.toClient.types.packet_acknowledge_player_digging, ['container', [{ name: 'sequenceId', type: 'varint' }]]);
  const s = fixture();
  s.client.emit('packet', { sequenceId: 37 }, { name: 'acknowledge_player_digging' });
  t.deepEqual(s.trace.snapshot()[0].fields, { sequenceId: 37 });
});
test('interaction trace preserves native sends and records only numeric interaction fields', t => {
  const s = fixture();
  s.client.write('block_place', { location: { x: -81, y: 105, z: 35 }, direction: 1, hand: 0, cursorX: 0.5, cursorY: 0.5, cursorZ: 0.5, sequence: 0, extra: 'secret' });
  t.deepEqual(s.sent, ['block_place']); t.is(s.trace.snapshot()[0].name, 'block_place');
  t.false(JSON.stringify(s.trace.snapshot()).includes('secret'));
});
test('interaction trace never retains credentials, chat, window titles or item components', t => {
  const s = fixture();
  for (const name of ['login_start', 'chat_message', 'custom_payload']) {
    s.client.write(name, { secret: 'private-marker' }); s.client.emit('packet', { secret: 'private-marker' }, { name });
  }
  s.client.emit('packet', { windowId: 2, inventoryType: 11, windowTitle: 'private-marker' }, { name: 'open_window' });
  s.client.emit('packet', { windowId: 2, stateId: 5, items: [{ nbt: 'private-marker' }], carriedItem: 'private-marker' }, { name: 'window_items' });
  const rows = s.trace.snapshot(); t.is(rows.length, 2); t.is(rows[1].fields.slotCount, 1);
  t.false(JSON.stringify(rows).includes('private-marker'));
});
test('interaction trace is bounded and includes local open/close separately', t => {
  const s = fixture();
  for (let i = 0; i < 80; i++) s.client.emit('packet', { sequence: i }, { name: 'block_changed_ack' });
  s.bot.emit('windowOpen', { id: 3, type: 'minecraft:crafting' } as NonNullable<Bot['currentWindow']>);
  s.bot.emit('windowClose', { id: 3, type: 'minecraft:crafting' } as NonNullable<Bot['currentWindow']>);
  const rows = s.trace.snapshot(); t.is(rows.length, 64); t.is(rows[62].direction, 'local'); t.is(rows[63].name, 'windowClose');
});
