#!/usr/bin/env python3
"""Native read-only observer. Reads existing private status files; sends no game/HTTP/IPC requests."""
import argparse
import datetime as dt
import json
import math
import os
from pathlib import Path
import re
import stat
import time

SESSION = re.compile(r'^session-\d{8}T\d{6}Z-[a-f0-9]{12}$')
ITEM = re.compile(r'^[a-z0-9_]{1,96}$')
BG, PANEL, CELL, EDGE, TEXT, MUTED = '#10191d', '#19272c', '#21353b', '#34515a', '#edf7f1', '#9cb4b6'
ACCENT, GOLD, RED = '#88d3aa', '#e5bf72', '#ec8b87'
FONT = 'DejaVu Sans'

def directory(path):
    path = Path(path).absolute()
    for parent in (path, *path.parents):
        if parent.is_symlink(): raise ValueError('Symlinked status directory rejected')
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Status directory must be private and user-owned')
    return path

def read_json(path):
    directory(path.parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'r') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 1048576:
            raise ValueError('Invalid private status report')
        value = json.load(stream)
    if not isinstance(value, dict): raise ValueError('Status report must be an object')
    return value

def number(value):
    try: return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None
    except OverflowError: return None

def item(value, valid_slots):
    if not isinstance(value, dict): return None
    slot, name, count = value.get('slot'), value.get('name'), value.get('count')
    if isinstance(slot, bool) or not isinstance(slot, int) or slot not in valid_slots or not isinstance(name, str) or not ITEM.fullmatch(name): return None
    if isinstance(count, bool) or not isinstance(count, int) or count < 1 or count > 999999: return None
    return {'slot': slot, 'name': name, 'count': count, 'durabilityUsed': number(value.get('durabilityUsed')), 'maxDurability': number(value.get('maxDurability'))}

def snapshot(root, now=None):
    root = directory(root)
    if (root / 'active-session.json').exists():
        sid = read_json(root / 'active-session.json').get('sessionId')
        if not isinstance(sid, str) or not SESSION.fullmatch(sid): raise ValueError('Invalid active session reference')
        root = directory(root / 'sessions' / sid)
    path = root / 'status.json' if (root / 'status.json').exists() else root / 'daemon' / 'status.json'
    raw = read_json(path)
    wrapper = raw.get('backend')
    if not isinstance(wrapper, dict) or not isinstance(wrapper.get('status'), dict): raise ValueError('Missing backend report')
    backend = wrapper['status']
    authority = backend.get('inventoryAuthority')
    if not isinstance(authority, dict): raise ValueError('Missing inventory authority')
    for key, owner in [('inventory', backend), ('equipment', authority)]:
        if owner.get(key) is not None and not isinstance(owner[key], list): raise ValueError('Invalid slot report')
    ages = []
    for timestamp in [raw.get('at'), backend.get('at')]:
        try:
            if not isinstance(timestamp, str): raise ValueError('Invalid report time')
            at = dt.datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
            ages.append(((now or dt.datetime.now(dt.timezone.utc)) - at).total_seconds())
        except (ValueError, TypeError, OverflowError): ages.append(None)
    fresh = all(age is not None and -5 <= age <= 30 for age in ages)
    age = max(ages) if all(age is not None for age in ages) else None
    broker_fenced = bool(raw.get('uncertain') or raw.get('detachFence') or raw.get('state') != 'ready')
    inventory, equipment = {}, {}
    for entry in backend.get('inventory') or []:
        clean = item(entry, range(9, 45))
        if clean: inventory[clean['slot']] = clean
    for entry in authority.get('equipment') or []:
        clean = item(entry, {5, 6, 7, 8, 45})
        if clean: equipment[clean['slot']] = clean
    pos = backend.get('position') or {}
    if not isinstance(pos, dict): raise ValueError('Invalid player position')
    evidence = backend.get('oxygenEvidence')
    own_air = isinstance(evidence, dict) and evidence.get('source') == 'self_entity_metadata' and evidence.get('known') is True and number(evidence.get('oxygen')) == number(backend.get('oxygen')) and number(evidence.get('oxygen')) is not None
    air_age = number(evidence.get('ageMs')) if own_air else None
    version = backend.get('backendVersion')
    if not isinstance(version, str) or not re.fullmatch(r'[A-Za-z0-9.+-]{1,40}', version): version = 'unknown'
    dimension = backend.get('dimension')
    if not isinstance(dimension, str) or not re.fullmatch(r'[a-z0-9_:.-]{1,64}', dimension): dimension = 'unknown'
    return {'version': version, 'ready': raw.get('ready') is True and backend.get('ready') is True and not raw.get('ended') and backend.get('ended') is False and not broker_fenced,
            'fresh': fresh, 'age': age, 'health': number(backend.get('health')), 'food': number(backend.get('food')),
            'oxygen': number(backend.get('oxygen')), 'ownAir': own_air, 'airAgeMs': air_age, 'position': {key: number(pos.get(key)) for key in ['x', 'y', 'z']},
            'dimension': dimension, 'inventoryReady': authority.get('ready') is True and isinstance(backend.get('inventory'), list),
            'fenced': bool(broker_fenced or authority.get('fence') or backend.get('controlFence')), 'cursorEmpty': 'cursor' in authority and authority['cursor'] is None,
            'inventory': inventory, 'equipment': equipment}

class Observer:
    def __init__(self, state_dir):
        import tkinter as tk
        self.tk, self.state_dir, self.last = tk, state_dir, None
        self.cpu_at, self.wall_at = time.process_time(), time.monotonic()
        self.root = tk.Tk(); self.root.title('Minecraft - Native Read-only Observer'); self.root.geometry('1070x790'); self.root.minsize(1010, 740)
        self.root.configure(bg=BG); self.root.option_add('*Font', (FONT, 11))
        self.icons, self.textures, self.slots, self.equipment = {}, {}, {}, {}
        assets = Path(__file__).resolve().parents[1] / 'node_modules/minecraft-assets/minecraft-assets/data/1.21.1/texture_content.json'
        if assets.is_file() and assets.stat().st_size < 2097152:
            self.textures = {x['name']: x['texture'] for x in json.loads(assets.read_text()) if isinstance(x, dict) and x.get('texture')}
        header = tk.Frame(self.root, bg=BG); header.pack(fill='x', padx=26, pady=(22, 16))
        self.label(header, 'MINECRAFT  /  OBSERVER', 23, TEXT).pack(side='left')
        self.badge = self.label(header, 'Reading snapshot', 12, GOLD); self.badge.pack(side='right')
        cards = tk.Frame(self.root, bg=BG); cards.pack(fill='x', padx=26)
        self.stats = {}
        for index, (key, title, color) in enumerate([('health', 'Health', ACCENT), ('food', 'Food', GOLD), ('oxygen', 'Reported air', '#91c8df')]):
            frame = tk.Frame(cards, bg=PANEL, padx=16, pady=13); frame.grid(row=0, column=index, sticky='ew', padx=(0, 10 if index < 2 else 0)); cards.columnconfigure(index, weight=1)
            self.label(frame, title, 11, MUTED, PANEL).pack(anchor='w')
            value = self.label(frame, '— / 20', 22, color, PANEL); value.pack(anchor='w')
            bar = tk.Canvas(frame, height=5, bg=EDGE, highlightthickness=0); bar.pack(fill='x', pady=(9, 0)); self.stats[key] = value, bar, color
        location = tk.Frame(self.root, bg=BG); location.pack(fill='x', padx=28, pady=16)
        self.position = self.label(location, 'Position -', 14, TEXT); self.position.pack(side='left')
        self.version = self.label(location, '', 10, MUTED); self.version.pack(side='right')
        body = tk.Frame(self.root, bg=BG); body.pack(fill='both', expand=True, padx=26)
        pack = tk.Frame(body, bg=PANEL, padx=16, pady=12); pack.pack(side='left', fill='both', expand=True, padx=(0, 14))
        self.label(pack, 'Inventory  /  server-confirmed slots', 14, TEXT, PANEL).pack(anchor='w', pady=(0, 12))
        grid = tk.Frame(pack, bg=PANEL); grid.pack(fill='x')
        for slot in range(9, 45):
            row, col = divmod(slot - 9, 9)
            if row == 3: row = 4
            cell = tk.Frame(grid, bg=CELL, width=74, height=76, highlightbackground=EDGE, highlightthickness=1)
            cell.grid(row=row, column=col, padx=2, pady=2); cell.grid_propagate(False); grid.columnconfigure(col, weight=1)
            self.label(cell, str(slot), 8, MUTED, CELL).place(x=3, y=1)
            icon = self.label(cell, '', 9, TEXT, CELL); icon.place(x=9, y=20, width=54, height=38)
            count = self.label(cell, '', 10, TEXT, CELL); count.place(relx=1, x=-5, y=61, anchor='e')
            self.slots[slot] = icon, count
        self.label(grid, 'Hotbar', 10, MUTED, PANEL).grid(row=3, column=0, columnspan=9, sticky='w', pady=(9, 3))
        self.inventory_note = self.label(pack, '', 10, MUTED, PANEL); self.inventory_note.pack(anchor='w', pady=(14, 0))
        side = tk.Frame(body, bg=PANEL, padx=18, pady=14, width=215); side.pack(side='right', fill='y'); side.pack_propagate(False)
        self.label(side, 'Equipment', 14, TEXT, PANEL).pack(anchor='w', pady=(0, 12))
        for slot, title in [(5, 'Helmet'), (6, 'Chest'), (7, 'Legs'), (8, 'Boots'), (45, 'Offhand')]:
            self.label(side, title, 10, MUTED, PANEL).pack(anchor='w')
            value = self.label(side, 'Empty', 10, TEXT, PANEL); value.configure(wraplength=170, justify='left'); value.pack(anchor='w', pady=(2, 12)); self.equipment[slot] = value
        self.fence = self.label(side, 'Cursor: empty', 10, ACCENT, PANEL); self.fence.pack(anchor='w', pady=(9, 0))
        self.updated = self.label(self.root, '', 10, MUTED); self.updated.pack(anchor='w', padx=28, pady=(14, 4))
        self.label(self.root, 'FILE-ONLY VIEW  |  1-second refresh  |  No game, HTTP or IPC requests  |  Closing this window keeps the game running', 9, MUTED).pack(anchor='w', padx=28, pady=(0, 18))
        self.root.after(0, self.refresh)
    def label(self, parent, text, size, color, background=BG):
        return self.tk.Label(parent, text=text, font=(FONT, size), bg=background, fg=color)
    def icon(self, name):
        if name not in self.icons:
            uri = self.textures.get(name, '')
            image = None
            if uri.startswith('data:image/png;base64,'):
                try:
                    image = self.tk.PhotoImage(data=uri.split(',', 1)[1])
                    if image.width() <= 16 and image.height() <= 16: image = image.zoom(2)
                    elif max(image.width(), image.height()) > 40: image = None
                except self.tk.TclError: pass
            self.icons[name] = image
        return self.icons[name]
    def refresh(self):
        try:
            value = snapshot(self.state_dir); self.last = value
            online = value['ready'] and value['fresh']
            self.badge.configure(text='LIVE  |  READ ONLY' if online else 'STALE / SESSION NOT READY', fg=ACCENT if online else GOLD)
            for key, (label, bar, color) in self.stats.items():
                number = value[key]; label.configure(text=(f"{number:g} ({'self sample' if value['ownAir'] else 'unverified'})" if key == 'oxygen' else f'{number:g} / 20') if number is not None else 'Unknown')
                bar.delete('all'); color = EDGE if key == 'oxygen' else color; bar.create_rectangle(0, 0, max(1, bar.winfo_width()) * min(20, max(0, number or 0)) / 20, 5, fill=color, outline='')
            coordinates = '    '.join(f'{key.upper()}  {val:.1f}' if val is not None else f'{key.upper()}  —' for key, val in value['position'].items())
            self.position.configure(text=coordinates); self.version.configure(text=f"{value['dimension']}   ·   {value['version']}")
            for slot, (label, count) in self.slots.items():
                entry = value['inventory'].get(slot) if value['inventoryReady'] else None
                image = self.icon(entry['name']) if entry else None
                label.configure(image=image or '', text='' if image or not entry else entry['name'][:13], wraplength=54)
                count.configure(text=str(entry['count']) if entry else '')
            for slot, label in self.equipment.items():
                entry = value['equipment'].get(slot); label.configure(text=f"{entry['name']} × {entry['count']}" if entry else 'Empty')
            self.inventory_note.configure(text=f"{len(value['inventory'])} / 36 slots occupied  |  {'Server snapshot confirmed' if value['inventoryReady'] else 'Awaiting complete snapshot'}")
            self.fence.configure(text=('Action fence: active' if value['fenced'] else 'Action fence: none') + ('\nCursor: empty' if value['cursorEmpty'] else '\nCursor: unknown / occupied'), fg=GOLD if value['fenced'] else ACCENT)
            cpu_now, wall_now = time.process_time(), time.monotonic()
            cpu = 100 * (cpu_now - self.cpu_at) / max(0.001, wall_now - self.wall_at); self.cpu_at, self.wall_at = cpu_now, wall_now
            rss = int(Path('/proc/self/statm').read_text().split()[1]) * os.sysconf('SC_PAGE_SIZE') / 1048576
            air_note = f" | Air sample age {value['airAgeMs'] / 1000:.0f}s" if value['ownAir'] and value['airAgeMs'] is not None else ''
            self.updated.configure(text=f"Observed {dt.datetime.now().strftime('%H:%M:%S')} | {'Fresh snapshot' if value['fresh'] else 'STALE snapshot'} | GUI RSS {rss:.1f} MiB | last-window CPU {cpu:.1f}%{air_note}")
        except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError, json.JSONDecodeError):
            self.badge.configure(text='UNAVAILABLE  |  OLD DATA MAY BE STALE', fg=RED)
            self.updated.configure(text='Status file unavailable. No connection or action is started.')
        finally:
            self.root.after(1000, self.refresh)
    def run(self): self.root.mainloop()

def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--state-dir', required=True); parser.add_argument('--check', action='store_true'); args = parser.parse_args()
    current = snapshot(args.state_dir)
    if args.check:
        print(json.dumps({'passed':True,'backendVersion':current['version'],'ready':current['ready'],'fresh':current['fresh'],'inventorySlots':len(current['inventory']),'fileOnly':True,'networkStarted':False,'gameRequestsSent':False})); return
    Observer(args.state_dir).run()
if __name__ == '__main__': main()
