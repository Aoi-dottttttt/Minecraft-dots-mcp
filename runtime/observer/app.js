const byId = id => document.getElementById(id);
let lastInventory = '', lastWindow = '';
function renderSlots(target, frame) {
  target.replaceChildren();
  if (!frame.ready) return;
  frame.slots.forEach((item, index) => {
    const slot = document.createElement('div'); slot.className = 'slot';
    const number = document.createElement('span'); number.className = 'number'; number.textContent = String(index); slot.append(number);
    if (item) {
      slot.title = `${item.name ?? 'Unknown item'} × ${item.count}`;
      const name = document.createElement('span'); name.className = 'name'; name.textContent = item.name ?? 'Unknown';
      if (item.name) {
        const img = document.createElement('img'); img.alt = item.name; img.src = `textures/${encodeURIComponent(item.name)}.png`;
        img.addEventListener('error', () => img.replaceWith(name), { once: true }); slot.append(img);
      } else slot.append(name);
      const count = document.createElement('span'); count.className = 'count'; count.textContent = String(item.count); slot.append(count);
    }
    target.append(slot);
  });
}
async function update() {
  try {
    const response = await fetch('api/snapshot', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw Error('Observer unavailable');
    const value = await response.json();
    byId('connection').textContent = value.connected ? `Last observation ${new Date(value.capturedAt).toLocaleTimeString()}` : 'Disconnected · last observed state';
    byId('connection').className = value.authority.fenced ? 'warning' : '';
    const status = byId('status'); status.replaceChildren();
    const fields = { Version: value.version, Health: value.health, Food: value.food, Oxygen: value.oxygen,
      Position: value.position ? Object.values(value.position).map(n => n === null ? '?' : n.toFixed(1)).join(', ') : 'Unavailable',
      Dimension: value.dimension, 'Action fence': value.authority.fenced ? 'Active' : 'None',
      Cursor: value.authority.cursorKnown ? value.authority.cursor ? `${value.authority.cursor.name} × ${value.authority.cursor.count}` : 'Empty' : 'Unconfirmed' };
    for (const [label, value] of Object.entries(fields)) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value ?? 'Unavailable'; status.append(dt, dd); }
    byId('inventory-state').textContent = value.inventory.ready ? `Server snapshot · revision ${value.authority.sequence}` : 'Awaiting a complete server inventory snapshot';
    const inventory = JSON.stringify(value.inventory); if (inventory !== lastInventory) { renderSlots(byId('inventory'), value.inventory); lastInventory = inventory; }
    byId('window-state').textContent = value.currentWindow.id === 0 ? 'No container window open' : `${value.currentWindow.type ?? 'Unknown layout'} · ${value.currentWindow.ready ? 'server snapshot' : 'awaiting confirmation'}`;
    const window = JSON.stringify(value.currentWindow); if (window !== lastWindow) { renderSlots(byId('window'), value.currentWindow.id === 0 ? { ready: false } : value.currentWindow); lastWindow = window; }
  } catch { byId('connection').textContent = 'Observation connection lost · displayed data may be stale'; byId('connection').className = 'warning'; }
  setTimeout(update, 1000);
}
void update();
