#!/usr/bin/env python3
"""Pure file fixtures. Never launches Godot or reads a game session."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
spec = importlib.util.spec_from_file_location('native_view', Path(__file__).with_name('native3d-launch.py'))
view = importlib.util.module_from_spec(spec); spec.loader.exec_module(view)
class RelayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.source = self.root / 'source'; self.source.mkdir(mode=0o700)
        self.mirror = self.root / 'mirror'; self.mirror.mkdir(mode=0o700)
        self.path = self.source / 'mesh-frame.json'; self.relay = view.FrameRelay(self.source, self.mirror)
    def tearDown(self): self.temp.cleanup()
    def test_original_lease_is_not_renewed(self):
        raw = b'{"status":"live","validUntil":"2026-01-01T00:00:05Z"}'
        view.atomic_write(self.path, raw); self.relay.update()
        self.assertEqual((self.mirror / 'mesh-frame.json').read_bytes(), raw)
    def test_missing_source_clears(self):
        self.relay.update(); self.assertEqual((self.mirror / 'mesh-frame.json').read_bytes(), view.STALE)
    def test_fifo_never_blocks(self):
        os.mkfifo(self.path,0o600); start=time.monotonic(); self.relay.update()
        self.assertLess(time.monotonic()-start, 1); self.assertEqual((self.mirror / 'mesh-frame.json').read_bytes(), view.STALE)
    def test_symlink_source_is_not_followed(self):
        target = self.root / 'untouched'; target.write_text('sentinel'); self.path.symlink_to(target)
        self.relay.update(); self.assertEqual(target.read_text(), 'sentinel')
        self.assertEqual((self.mirror / 'mesh-frame.json').read_bytes(), view.STALE)
    def test_metadata_symlink_cannot_truncate_target(self):
        target = self.root / 'untouched'; target.write_text('sentinel'); output = self.source / 'native-view-run.json'; output.symlink_to(target)
        with self.assertRaises(ValueError): view.atomic_write(output,b'new')
        self.assertEqual(target.read_text(),'sentinel')
    def test_oversized_source_clears(self):
        with self.path.open('wb') as f: f.truncate(view.MAX_BYTES+1)
        self.path.chmod(0o600); self.relay.update(); self.assertEqual((self.mirror / 'mesh-frame.json').read_bytes(),view.STALE)
    def test_public_source_clears(self):
        self.path.write_text('{}'); self.path.chmod(0o644); self.relay.update()
        self.assertEqual((self.mirror / 'mesh-frame.json').read_bytes(),view.STALE)
    def test_atomic_modes_cleanup_and_close(self):
        view.atomic_write(self.path,b'{}'); self.assertEqual(self.path.stat().st_mode & 0o777,0o600)
        self.relay.update(); self.relay.close(); self.assertEqual((self.mirror/'mesh-frame.json').read_bytes(),view.STALE)
        self.assertFalse(list(self.source.glob('.native-*')))
    def test_directory_symlink_rejected(self):
        link=self.root/'link';link.symlink_to(self.source, target_is_directory=True)
        with self.assertRaises(ValueError): view.private_directory(link)
if __name__=='__main__': unittest.main()
