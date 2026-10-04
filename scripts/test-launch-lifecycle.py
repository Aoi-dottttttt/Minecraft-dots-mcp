#!/usr/bin/env python3
# Modified for 3.1.0-dot.1 release (2026-10-04). See RELEASE.md.
"""Deterministic offline lifecycle tests. No bridge, game, or credentials used."""
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import signal
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'runtime'))
from process_gate import ProcessGate
spec = importlib.util.spec_from_file_location('launch_ui', ROOT / 'runtime' / 'launch-ui.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class DummyProcess:
    def __init__(self, pid):
        self.pid = pid
        self.alive = True
        self.identity = {'pid': pid}

    def poll(self):
        return None if self.alive else 0


class ImmediateThread:
    def __init__(self, target, **_kwargs):
        self.target = target

    def start(self):
        self.target()


class LifecycleTests(unittest.TestCase):
    def harness(self, path):
        app = launcher.Launcher.__new__(launcher.Launcher)
        app.gate = ProcessGate()
        app.report_lock = threading.RLock()
        app.session = path / 'sessions' / 'session-20261004T000000Z-012345abcdef'
        app.daemon_dir = app.session / 'daemon'
        app.daemon_dir.mkdir(parents=True, exist_ok=True)
        app.state = path
        app.controller_dir = None
        app.bridge = app.daemon = app.controller = None
        app.stopped = app.closing = app.starting = app.controller_busy = False
        app.discovery_blocked = False
        app.port = None
        app.messages = []
        app.post = app.messages.append
        app.status = types.SimpleNamespace(set=app.messages.append)
        app.refresh_buttons = lambda: None
        app.root = types.SimpleNamespace(destroy=lambda: app.messages.append('destroyed'))
        return app

    def test_stop_before_start_never_calls_factory(self):
        gate = ProcessGate()
        self.assertEqual(gate.stop(), ())
        called = []
        self.assertIsNone(gate.start(lambda: called.append(True)))
        self.assertEqual(called, [])
        self.assertFalse(gate.reopen_frontend())

    def race_spawn(self, role, action):
        gate = ProcessGate()
        entered, release, stopping = threading.Event(), threading.Event(), threading.Event()
        child = object()
        results = []
        def factory():
            entered.set()
            if not release.wait(3):
                raise RuntimeError('Test coordination timeout')
            return child
        starter = threading.Thread(target=lambda: gate.start(factory, role))
        starter.start()
        self.assertTrue(entered.wait(3))
        def stop():
            stopping.set()
            results.append(action(gate))
        stopper = threading.Thread(target=stop)
        stopper.start()
        self.assertTrue(stopping.wait(3))
        release.set()
        starter.join(3)
        stopper.join(3)
        self.assertFalse(starter.is_alive())
        self.assertFalse(stopper.is_alive())
        self.assertIsNone(gate.start(lambda: object(), 'daemon'))
        return child, results

    def test_stop_during_spawn_captures_child_and_blocks_later_spawns(self):
        child, results = self.race_spawn('daemon', lambda gate: gate.stop())
        self.assertEqual(results, [(child,)])

    def test_close_during_daemon_spawn_preserves_registered_daemon(self):
        _, results = self.race_spawn('daemon', lambda gate: gate.close_ui())
        self.assertEqual(results, [((), True)])

    def test_close_during_bridge_spawn_cancels_incomplete_start(self):
        child, results = self.race_spawn('bridge', lambda gate: gate.close_ui())
        self.assertEqual(results, [((child,), False)])

    def test_close_only_detaches_frontend_after_daemon_registered(self):
        gate = ProcessGate()
        bridge, daemon, frontend = object(), object(), object()
        gate.start(lambda: bridge, 'bridge')
        gate.start(lambda: daemon, 'daemon')
        gate.start(lambda: frontend, 'frontend')
        self.assertEqual(gate.close_ui(), ((frontend,), True))
        self.assertIsNone(gate.start(lambda: object(), 'frontend'))
        self.assertFalse(gate.reopen_frontend())
        self.assertEqual(gate.stop(), (bridge, daemon, frontend))

    def test_frontend_restart_cannot_reopen_a_stopped_gate(self):
        gate = ProcessGate()
        daemon, frontend = object(), object()
        gate.start(lambda: daemon, 'daemon')
        gate.start(lambda: frontend, 'frontend')
        self.assertEqual(gate.detach(), (frontend,))
        self.assertIsNone(gate.start(lambda: object(), 'frontend'))
        self.assertTrue(gate.reopen_frontend())
        replacement = object()
        self.assertIs(gate.start(lambda: replacement, 'frontend'), replacement)
        self.assertEqual(gate.stop(), (daemon, frontend, replacement))
        self.assertFalse(gate.reopen_frontend())

    def test_stop_terminates_owned_processes_even_when_report_storage_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            app = self.harness(pathlib.Path(directory))
            app.bridge, app.daemon, app.controller = [DummyProcess(pid) for pid in (101, 102, 103)]
            for role, process in [('bridge', app.bridge), ('daemon', app.daemon), ('frontend', app.controller)]:
                app.gate.adopt(process, role)
            terminated = []
            with mock.patch.object(launcher, 'write_report', side_effect=OSError('Synthetic storage failure')), \
                 mock.patch.object(launcher, 'terminate', side_effect=terminated.append), \
                 mock.patch.object(launcher.threading, 'Thread', ImmediateThread):
                app.stop()
            self.assertEqual(terminated, [app.controller, app.daemon, app.bridge])
            self.assertTrue(app.stopped)
            self.assertIsNone(app.gate.start(lambda: object()))

    def test_close_preserves_game_and_never_writes_stop_request(self):
        with tempfile.TemporaryDirectory() as directory:
            app = self.harness(pathlib.Path(directory))
            app.bridge, app.daemon, app.controller = [DummyProcess(pid) for pid in (101, 102, 103)]
            for role, process in [('bridge', app.bridge), ('daemon', app.daemon), ('frontend', app.controller)]:
                app.gate.adopt(process, role)
            terminated = []
            with mock.patch.object(launcher, 'terminate', side_effect=terminated.append), \
                 mock.patch.object(launcher.threading, 'Thread', ImmediateThread):
                app.close()
            self.assertEqual(terminated, [app.controller])
            self.assertFalse((app.daemon_dir / 'stop.request').exists())
            self.assertTrue(json.loads((app.session / 'ui-closed.json').read_text())['gamePreserved'])
            self.assertIn('destroyed', app.messages)

    def test_restarts_use_fresh_controller_queues_and_never_spawn_bridge(self):
        with tempfile.TemporaryDirectory() as directory:
            app = self.harness(pathlib.Path(directory))
            app.daemon = DummyProcess(102)
            app.gate.adopt(app.daemon, 'daemon')
            launcher.write_report(app.daemon_dir, 'session.json', {'state': 'ready', 'pid': 102})
            spawns = []
            def spawn(arguments, role):
                spawns.append((arguments, role))
                child = DummyProcess(110 + len(spawns))
                app.controller = app.gate.start(lambda: child, role)
                return app.controller
            app.spawn = spawn
            with mock.patch.object(launcher, 'terminate', side_effect=lambda child: setattr(child, 'alive', False)):
                app.attach_controller()
                first = app.controller_dir
                (first / 'commands').mkdir()
                (first / 'commands' / 'stale-command.json').write_text('{}')
                app.attach_controller(restart=True)
            self.assertNotEqual(first, app.controller_dir)
            self.assertFalse((app.controller_dir / 'commands').exists())
            self.assertEqual(len(spawns), 2)
            for arguments, role in spawns:
                self.assertEqual(pathlib.Path(arguments[0]).name, 'minecraft-client.mjs')
                self.assertEqual(arguments[1:3], ['--attach', app.daemon_dir])
                self.assertEqual(role, 'frontend')
            self.assertTrue(app.daemon.alive)

    def test_reopen_adopts_incomplete_owned_bridge_for_explicit_stop_only(self):
        with tempfile.TemporaryDirectory() as directory:
            app = self.harness(pathlib.Path(directory))
            old_session = app.session
            bridge = DummyProcess(101)
            launcher.write_report(app.state, 'active-session.json', {'sessionId': old_session.name})
            launcher.write_report(old_session, 'processes.json', {'schema': 1, 'sessionId': old_session.name,
                                  'processes': {'bridge': bridge.identity}})
            app.session = app.daemon_dir = None
            with mock.patch.object(launcher, 'OwnedProcess', return_value=bridge), \
                 mock.patch.object(launcher.subprocess, 'Popen', side_effect=AssertionError('Opening UI cannot start a process')), \
                 mock.patch.object(launcher, 'terminate') as terminate:
                app.discover()
                terminate.assert_not_called()
            self.assertEqual(app.session, old_session)
            self.assertIs(app.bridge, bridge)
            self.assertIsNone(app.daemon)
            self.assertFalse(app.discovery_blocked)
            self.assertEqual(app.gate.stop(), (bridge,))

    def test_reopen_recovers_daemon_without_reattaching_controller(self):
        with tempfile.TemporaryDirectory() as directory:
            app = self.harness(pathlib.Path(directory))
            old_session = app.session
            daemon = DummyProcess(102)
            launcher.write_report(app.state, 'active-session.json', {'sessionId': old_session.name})
            launcher.write_report(old_session, 'processes.json', {'schema': 1, 'sessionId': old_session.name,
                                  'processes': {'daemon': daemon.identity}})
            app.session = app.daemon_dir = None
            with mock.patch.object(launcher, 'OwnedProcess', return_value=daemon), \
                 mock.patch.object(launcher.subprocess, 'Popen', side_effect=AssertionError('Opening UI cannot start a process')):
                app.discover()
            self.assertIs(app.daemon, daemon)
            self.assertIsNone(app.controller)
            self.assertIsNone(app.controller_dir)
            self.assertEqual(app.gate.close_ui(), ((), True))

    def test_check_does_not_open_config_create_state_or_start_ui(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory)
            output = io.StringIO()
            with mock.patch.object(launcher, 'Launcher', side_effect=AssertionError('UI must not open')), \
                 mock.patch.object(launcher.subprocess, 'Popen', side_effect=AssertionError('No process may start')), \
                 contextlib.redirect_stdout(output):
                self.assertEqual(launcher.main(['--config', str(path / 'nonexistent-secret'), '--bridge', __file__,
                                 '--node', sys.executable, '--state-dir', str(path / 'must-not-exist'), '--check']), 0)
            report = json.loads(output.getvalue())
            self.assertFalse(report['credentialsRead'])
            self.assertFalse(report['networkStarted'])
            self.assertFalse((path / 'must-not-exist').exists())

    def test_owned_process_rejects_reused_pid_without_signalling(self):
        identity = {'pid': 12345, 'processGroup': 12345, 'startTicks': '1'}
        with mock.patch.object(launcher.os, 'pidfd_open', return_value=91), \
             mock.patch.object(launcher.os, 'close') as close, \
             mock.patch.object(launcher, 'process_identity', return_value={**identity, 'startTicks': '2'}), \
             mock.patch.object(launcher.signal, 'pidfd_send_signal') as send:
            with self.assertRaises(RuntimeError):
                launcher.OwnedProcess(identity)
            send.assert_not_called()
            self.assertEqual(close.call_args_list.count(mock.call(91)), 1)

    def test_owned_process_uses_pidfd_and_cleans_only_its_offline_child(self):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            owned = launcher.OwnedProcess.spawned(child)
            self.assertEqual(owned.identity['pid'], child.pid)
            self.assertEqual(owned.identity['processGroup'], child.pid)
            launcher.terminate(owned, timeout=2)
            self.assertIsNotNone(child.poll())
        finally:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=3)

    def test_offline_close_reopen_restart_preserves_backend_until_explicit_stop(self):
        def until(predicate, message):
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                try:
                    if predicate():
                        return
                except (OSError, ValueError, KeyError):
                    pass
                time.sleep(0.05)
            self.fail(message)
        def read(path):
            return launcher.read_report(path)
        with tempfile.TemporaryDirectory(prefix='minecraft-ui-') as directory:
            app = self.harness(pathlib.Path(directory))
            app.node = pathlib.Path(shutil.which('node'))
            for path in [app.state, app.session, app.daemon_dir]:
                launcher.private_dir(path)
            launcher.write_report(app.state, 'active-session.json', {'sessionId': app.session.name})
            # A local sleeping process stands in for bridge lifetime. It has no
            # sockets, credentials, config, Minecraft, or relay interaction.
            dummy = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'],
                                     start_new_session=True, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            app.bridge = launcher.OwnedProcess.spawned(dummy)
            app.gate.adopt(app.bridge, 'bridge')
            owned = [app.bridge]
            try:
                daemon = app.spawn([ROOT / 'runtime' / 'minecraft-daemon.mjs', '--offline-fixture',
                                    '--state-dir', app.daemon_dir], 'daemon')
                owned.append(daemon)
                until(lambda: read(app.daemon_dir / 'session.json')['state'] == 'ready', 'Offline daemon not ready')
                backend_pid = read(app.daemon_dir / 'session.json')['backendPid']
                app.attach_controller()
                owned.append(app.controller)
                first_dir = app.controller_dir
                until(lambda: read(first_dir / 'session.json')['state'] == 'mcp_connected', 'First controller not connected')
                until(lambda: read(app.daemon_dir / 'status.json')['controllerAttached'], 'First controller not attached')
                with mock.patch.object(launcher.threading, 'Thread', ImmediateThread):
                    app.close()
                until(lambda: not read(app.daemon_dir / 'status.json')['controllerAttached'], 'Close did not detach frontend')
                self.assertIsNone(daemon.poll())
                self.assertIsNone(app.bridge.poll())
                self.assertEqual(read(app.daemon_dir / 'session.json')['backendPid'], backend_pid)
                self.assertFalse((app.daemon_dir / 'stop.request').exists())
                reopened = self.harness(pathlib.Path(directory))
                reopened.session = reopened.daemon_dir = None
                reopened.node = app.node
                reopened.discover()
                self.assertFalse(reopened.discovery_blocked, reopened.messages)
                self.assertIsNotNone(reopened.daemon)
                self.assertIsNone(reopened.controller)
                reopened.attach_controller()
                owned.append(reopened.controller)
                until(lambda: read(reopened.controller_dir / 'session.json')['state'] == 'mcp_connected', 'Reattached controller not connected')
                second_dir = reopened.controller_dir
                reopened.attach_controller(restart=True)
                owned.append(reopened.controller)
                until(lambda: read(reopened.controller_dir / 'session.json')['state'] == 'mcp_connected', 'Restarted controller not connected')
                self.assertNotEqual(first_dir, second_dir)
                self.assertNotEqual(second_dir, reopened.controller_dir)
                self.assertEqual(read(reopened.daemon_dir / 'session.json')['backendPid'], backend_pid)
                self.assertEqual(read(reopened.session / 'current-controller.json')['controllerId'], reopened.controller_dir.name)
                with mock.patch.object(launcher.threading, 'Thread', ImmediateThread):
                    reopened.stop()
                until(lambda: daemon.poll() is not None and app.bridge.poll() is not None, 'Explicit Stop did not end owned session')
                self.assertTrue(read(reopened.daemon_dir / 'closed.json')['closed'])
            finally:
                for process in reversed(owned):
                    launcher.terminate(process)

    def test_private_report_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory)
            (path / 'real').write_text('{}')
            (path / 'linked').symlink_to(path / 'real')
            with self.assertRaises(OSError):
                launcher.read_report(path / 'linked')


if __name__ == '__main__':
    unittest.main()
