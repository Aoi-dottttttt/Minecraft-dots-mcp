#!/usr/bin/env python3
"""Neutral, file-only native observer tests; no display, socket or game needed."""
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('observer_ui', Path(__file__).resolve().parents[1] / 'runtime/observer-ui.py')
ui = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ui)

class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.path = self.root / 'status.json'
        self.now = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
        self.raw = {'at': self.now.isoformat(), 'state': 'ready', 'ready': True, 'backend': {'status': {
            'at': self.now.isoformat(), 'ready': True, 'ended': False, 'backendVersion': '3.2.0-rc.3', 'health': 20, 'food': 18, 'oxygen': 312,
            'position': {'x': 0.5, 'y': 64, 'z': 0.5}, 'dimension': 'overworld',
            'inventory': [{'slot': 9, 'name': 'stone', 'count': 2, 'nbt': {'secret': 'PRIVATE_BOOK'}}],
            'inventoryAuthority': {'ready': True, 'cursor': None, 'equipment': []},
            'chat': ['PRIVATE_CHAT'], 'config': {'password': 'PRIVATE_TOKEN'}}}}
        self.write()
    def tearDown(self): self.temp.cleanup()
    def write(self):
        self.path.write_text(json.dumps(self.raw)); self.path.chmod(0o600)
    def read(self): return ui.snapshot(self.root, self.now)
    def test_allowlist_and_reported_air(self):
        value = self.read(); self.assertTrue(value['ready'] and value['fresh'])
        self.assertEqual(value['inventory'][9]['count'], 2)
        self.assertEqual(value['oxygen'], 312); self.assertFalse(value['ownAir'])
        self.assertNotIn('PRIVATE_', json.dumps(value))
    def test_own_air_evidence(self):
        backend = self.raw['backend']['status']; backend['oxygen'] = 20
        backend['oxygenEvidence'] = {'source': 'self_entity_metadata', 'known': True, 'oxygen': 20, 'ageMs': 4321}
        self.write(); self.assertTrue(self.read()['ownAir']); self.assertEqual(self.read()['airAgeMs'], 4321)
        backend['oxygenEvidence']['oxygen'] = 19; self.write(); self.assertFalse(self.read()['ownAir'])
    def test_unknown_and_nonfinite(self):
        backend = self.raw['backend']['status']; backend['oxygen'] = None; backend['health'] = float('nan')
        backend['position']['x'] = True; self.write(); value = self.read()
        self.assertIsNone(value['oxygen']); self.assertIsNone(value['health']); self.assertIsNone(value['position']['x'])
    def test_stale_and_future(self):
        for delta in [-31, 6]:
            self.raw['at'] = (self.now + dt.timedelta(seconds=delta)).isoformat(); self.write(); self.assertFalse(self.read()['fresh'])
    def test_backend_age_and_broker_uncertainty(self):
        backend = self.raw['backend']['status']; backend['at'] = (self.now - dt.timedelta(seconds=300)).isoformat()
        self.raw['uncertain'] = True; self.write(); value = self.read()
        self.assertFalse(value['fresh']); self.assertFalse(value['ready']); self.assertTrue(value['fenced'])
        del self.raw['uncertain']; backend['at'] = self.now.isoformat()
        for field, val in [('detachFence', True), ('state', 'closing')]:
            self.raw[field] = val; self.write(); value = self.read()
            self.assertFalse(value['ready']); self.assertTrue(value['fenced'])
            self.raw.pop(field)
    def test_malformed_time_and_huge_number(self):
        for timestamp in [None, 123, 'not-a-date']:
            self.raw['at'] = timestamp; self.raw['backend']['status']['health'] = 10 ** 400; self.write()
            value = self.read(); self.assertFalse(value['fresh']); self.assertIsNone(value['health'])
    def test_refresh_reschedules_after_read_failure(self):
        class FakeWidget:
            def configure(self, **kwargs): self.last = kwargs
            def after(self, delay, callback): self.scheduled = delay
        observer = ui.Observer.__new__(ui.Observer)
        observer.root = FakeWidget(); observer.badge = FakeWidget(); observer.updated = FakeWidget()
        observer.state_dir = self.root; self.raw['backend'] = []; self.write()
        observer.refresh()
        self.assertEqual(observer.root.scheduled, 1000)
        self.assertIn('UNAVAILABLE', observer.badge.last['text'])
    def test_ended(self):
        self.raw['backend']['status']['ended'] = True; self.write(); self.assertFalse(self.read()['ready'])
    def test_unknown_cursor_is_not_empty(self):
        del self.raw['backend']['status']['inventoryAuthority']['cursor']; self.write(); self.assertFalse(self.read()['cursorEmpty'])
    def test_invalid_slot_projection(self):
        backend = self.raw['backend']['status']
        backend['inventory'] = [{'slot': slot, 'name': 'stone', 'count': 1} for slot in [True, 9.0, 8, 45]]
        self.write(); self.assertEqual(self.read()['inventory'], {})
    def test_malformed_nested_reports(self):
        for key, value in [('inventory', {}), ('position', [1]), ('inventoryAuthority', [])]:
            old = self.raw['backend']['status'][key]; self.raw['backend']['status'][key] = value; self.write()
            with self.assertRaises(ValueError): self.read()
            self.raw['backend']['status'][key] = old
        self.raw['backend'] = []; self.write()
        with self.assertRaises(ValueError): self.read()
    def test_public_or_large_file_rejected(self):
        self.path.chmod(0o644)
        with self.assertRaises(ValueError): self.read()
        self.path.chmod(0o600); self.path.write_text(' ' * 1048577)
        with self.assertRaises(ValueError): self.read()
    def test_symlink_rejected(self):
        target = self.root / 'target.json'; self.path.rename(target); self.path.symlink_to(target)
        with self.assertRaises(OSError): self.read()
    def test_invalid_active_session_reference(self):
        path = self.root / 'active-session.json'; path.write_text('{"sessionId":"../elsewhere"}'); path.chmod(0o600)
        with self.assertRaises(ValueError): self.read()
    def test_valid_session_reference(self):
        sid = 'session-20260101T000000Z-0123456789ab'
        daemon = self.root / 'sessions' / sid / 'daemon'; daemon.mkdir(parents=True, mode=0o700)
        for parent in [daemon.parent, daemon.parent.parent]: parent.chmod(0o700)
        self.path.rename(daemon / 'status.json')
        path = self.root / 'active-session.json'; path.write_text(json.dumps({'sessionId': sid})); path.chmod(0o600)
        self.assertTrue(self.read()['fresh'])

if __name__ == '__main__': unittest.main()
