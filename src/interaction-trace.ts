import type { Bot } from 'mineflayer';

type Row = { sequence: number; at: string; direction: 'sent' | 'received' | 'local'; name: string; fields: Record<string, unknown> };
const numeric = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const position = (value: unknown) => { const p = record(value); return { x: numeric(p.x), y: numeric(p.y), z: numeric(p.z) }; };
const menuType = (value: unknown): number | string | null => typeof value === 'number' ? numeric(value) : typeof value === 'string' && /^minecraft:[a-z0-9_]{1,48}$/.test(value) ? value : null;

/** Small allowlisted game-interaction trace. Never captures login, chat, titles,
 * plugin payloads, raw items/components, URLs, credentials or network endpoints. */
export function installInteractionTrace(bot: Bot): { snapshot(): Row[] } {
  const rows: Row[] = []; let sequence = 0;
  const push = (direction: Row['direction'], name: string, fields: Row['fields']) => {
    rows.push({ sequence: ++sequence, at: new Date().toISOString(), direction, name, fields });
    if (rows.length > 64) rows.shift();
  };
  const packet = (direction: 'sent' | 'received', name: string, raw: unknown) => {
    const p = record(raw); let fields: Row['fields'];
    switch (name) {
      case 'block_place': fields = { location: position(p.location), direction: numeric(p.direction), hand: numeric(p.hand), cursorX: numeric(p.cursorX), cursorY: numeric(p.cursorY), cursorZ: numeric(p.cursorZ), sequence: numeric(p.sequence), insideBlock: p.insideBlock === true }; break;
      // The installed Java 1.21.1 / protocol 767 schema names this sequenceId.
      case 'acknowledge_player_digging': fields = { sequenceId: numeric(p.sequenceId) }; break;
      case 'block_changed_ack': fields = { sequence: numeric(p.sequence), status: numeric(p.status), location: p.location ? position(p.location) : null }; break;
      case 'open_window': fields = { windowId: numeric(p.windowId), inventoryType: menuType(p.inventoryType), slotCount: numeric(p.slotCount), localWindowId: numeric(bot.currentWindow?.id), localWindowType: menuType(bot.currentWindow?.type) }; break;
      case 'close_window': fields = { windowId: numeric(p.windowId) }; break;
      case 'window_items': fields = { windowId: numeric(p.windowId), stateId: numeric(p.stateId), slotCount: Array.isArray(p.items) ? p.items.length : null, localWindowId: numeric(bot.currentWindow?.id), localWindowType: menuType(bot.currentWindow?.type) }; break;
      case 'window_click': fields = { windowId: numeric(p.windowId), stateId: numeric(p.stateId), slot: numeric(p.slot), mouseButton: numeric(p.mouseButton), mode: numeric(p.mode) }; break;
      case 'set_slot': fields = { windowId: numeric(p.windowId), stateId: numeric(p.stateId), slot: numeric(p.slot) }; break;
      case 'use_item': fields = { hand: numeric(p.hand), sequence: numeric(p.sequence) }; break;
      case 'entity_action': fields = { actionId: numeric(p.actionId) }; break;
      default: return;
    }
    push(direction, name, fields);
  };
  const write = bot._client.write.bind(bot._client);
  bot._client.write = ((name: string, payload: unknown) => { const result = write(name, payload); packet('sent', name, payload); return result; }) as Bot['_client']['write'];
  bot._client.on('packet', (data: unknown, meta: { name: string }) => packet('received', meta.name, data));
  bot.on('windowOpen', window => push('local', 'windowOpen', { id: numeric(window.id), type: menuType(window.type) }));
  bot.on('windowClose', window => push('local', 'windowClose', { id: numeric(window?.id), type: menuType(window?.type) }));
  return { snapshot: () => rows.map(row => ({ ...row, fields: { ...row.fields } })) };
}
