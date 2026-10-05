#!/usr/bin/env python3
# Modified for the public-candidate release; see RELEASE.md.
# Modified for 3.2.0-rc.2 release (2026-10-05). See RELEASE.md.
"""Explicit Start, persistent game daemon, and replaceable controller frontend.

Opening a window reads only non-secret ownership/status reports. The bridge is
started only by Start; Reattach and Restart Controller never start a bridge.
"""
import argparse
import fcntl
import hashlib
import json
import os
import pathlib
import queue
import re
import shutil
import signal
import stat
import subprocess
import sys
import threading
import time
import uuid

sys.dont_write_bytecode = True
from process_gate import ProcessGate

VERSION = '3.2.0-rc.2'
BASE = pathlib.Path(__file__).resolve().parent
SESSION_NAME = re.compile(r'^session-\d{8}T\d{6}Z-[a-f0-9]{12}$')


def private_dir(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    for component in (path, *path.parents):
        ancestor = component.lstat()
        if not stat.S_ISDIR(ancestor.st_mode) or component.is_symlink():
            raise RuntimeError('State directory ancestors must be real directories')
    info = path.lstat()
    if path.is_symlink() or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise RuntimeError('State must be a user-owned real directory')
    path.chmod(0o700)


def read_report(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'r') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > 1048576:
            raise RuntimeError('Invalid private session report')
        result = json.load(stream)
    if not isinstance(result, dict):
        raise ValueError('Invalid session report')
    return result


def write_report(directory, name, value):
    # Fresh unpredictable temporary names also avoid stale temporary symlinks.
    path = directory / name
    temporary = directory / ('.' + name + '-' + uuid.uuid4().hex + '.tmp')
    try:
        with open(temporary, 'x') as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.write('\n')
        temporary.replace(path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def clean_env(proxy=False):
    allowed = {'HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'TZ'}
    if proxy:
        allowed |= {'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
                    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
                    'NODE_EXTRA_CA_CERTS'}
    return {key: value for key, value in os.environ.items() if key in allowed}


def process_identity(pid):
    """Linux identity, excluding process arguments from the persisted report."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1:
        raise ValueError('Invalid owned PID')
    proc = pathlib.Path('/proc') / str(pid)
    info = proc.stat()
    if info.st_uid != os.getuid():
        raise RuntimeError('Process is not owned by this user')
    fields = (proc / 'stat').read_text().rsplit(')', 1)[1].split()
    if fields[0] == 'Z':
        raise ProcessLookupError('Process already exited')
    return {'pid': pid, 'uid': info.st_uid, 'startTicks': fields[19],
            'bootId': pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
            'processGroup': int(fields[2]),
            'commandHash': hashlib.sha256((proc / 'cmdline').read_bytes()).hexdigest()}


class OwnedProcess:
    """A process handle backed by current ownership and a stable Linux pidfd.

    Reopening a launcher never trusts a PID alone and never signals a process
    group read from a stale file. pidfd signaling remains bound to the verified
    process even if its numeric PID is subsequently reused.
    """
    def __init__(self, identity, child=None):
        self.identity = identity
        self.pid = identity.get('pid')
        self.child = child
        self.pidfd = None
        if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
            raise RuntimeError('Stable Linux process handles are required')
        self.pidfd = os.pidfd_open(self.pid)
        try:
            if process_identity(self.pid) != identity or identity['processGroup'] != self.pid:
                raise RuntimeError('Owned process identity could not be verified')
        except BaseException:
            os.close(self.pidfd)
            self.pidfd = None
            raise

    @classmethod
    def spawned(cls, child):
        try:
            return cls(process_identity(child.pid), child)
        except BaseException:
            # This is our direct child, just created in this call, never a PID
            # recovered from disk. Reap it if recording ownership failed.
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=3)
            raise

    def _close_owner_input(self):
        stream = getattr(getattr(self, 'child', None), 'stdin', None)
        if stream is not None:
            try:
                stream.close()
            except (OSError, ValueError):
                pass

    def __del__(self):
        self._close_owner_input()
        descriptor = getattr(self, 'pidfd', None)
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
            self.pidfd = None

    def poll(self):
        if self.child is not None:
            result = self.child.poll()
            if result is not None:
                self._close_owner_input()
            return result
        try:
            if process_identity(self.pid) != self.identity:
                return 0
        except (OSError, ValueError, RuntimeError, IndexError):
            return 0
        return None

    def send_signal(self, sig):
        if self.poll() is not None:
            return
        signal.pidfd_send_signal(self.pidfd, sig)

    def wait(self, timeout):
        if self.child is not None:
            result = self.child.wait(timeout=timeout)
            self._close_owner_input()
            return result
        deadline = time.monotonic() + timeout
        while self.poll() is None:
            if time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(['owned-process'], timeout)
            time.sleep(0.05)
        return 0


def terminate(process, timeout=5):
    """Stop only a verified handle; used on explicit Stop or frontend detach."""
    if process is None or process.poll() is not None:
        return
    try:
        process.send_signal(signal.SIGTERM)
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.send_signal(signal.SIGKILL)
            process.wait(timeout=3)
    except ProcessLookupError:
        pass


class Launcher:
    def __init__(self, args, root, tk):
        self.args, self.root = args, root
        self.state = pathlib.Path(args.state_dir).expanduser().absolute()
        self.config = pathlib.Path(args.config).expanduser().absolute()
        self.bridge_program = pathlib.Path(args.bridge).expanduser().absolute()
        self.node = pathlib.Path(args.node).expanduser().absolute()
        self.gate = ProcessGate()
        self.report_lock = threading.RLock()
        self.updates = queue.Queue()
        self.bridge = self.daemon = self.controller = None
        self.session = self.daemon_dir = self.controller_dir = None
        self.starting = self.controller_busy = self.stopped = self.closing = False
        self.discovery_blocked = False
        self.port = None
        self.status = tk.StringVar(value='Ready. No credential has been read and no connection has started.')
        root.title('MCPBot · Controller ' + VERSION)
        root.geometry('760x545')
        root.resizable(False, False)
        tk.Label(root, text='MCPBot · Persistent Minecraft MCP', font=('DejaVu Sans', 21, 'bold')).pack(pady=(18, 10))
        tk.Label(root, text='Start uses your private connection credential through the existing bridge at\n' + args.relay_label + ', then starts one persistent MCPBot game session.\n\nReattach / Restart Controller keeps that same game connection.\nClosing this window detaches control; MCPBot stays connected.\nStop MCPBot quits the game and stops this owned daemon and bridge.\nNo automatic reconnect, controller restart, or old-command replay.',
                 justify='left', font=('DejaVu Sans', 11)).pack(pady=8)
        tk.Label(root, textvariable=self.status, wraplength=700, font=('DejaVu Sans', 11)).pack(pady=12)
        self.start_button = tk.Button(root, text='Start MCPBot', command=self.start, font=('DejaVu Sans', 15, 'bold'), width=24, bg='#78c8a2')
        self.start_button.pack(pady=4)
        self.attach_button = tk.Button(root, text='Reattach Controller', command=self.reattach, width=26)
        self.attach_button.pack(pady=3)
        self.restart_button = tk.Button(root, text='Restart Controller', command=self.restart_controller, width=26)
        self.restart_button.pack(pady=3)
        self.stop_button = tk.Button(root, text='Stop MCPBot (quit game)', command=self.stop, width=26)
        self.stop_button.pack(pady=3)
        tk.Label(root, text='Closing before the daemon starts cancels startup. Opening this window never signs in.', font=('DejaVu Sans', 9)).pack(pady=8)
        root.protocol('WM_DELETE_WINDOW', self.close)
        self.discover()
        self.refresh_buttons()
        write_report(self.state, 'ui-ready.json', {'state': 'waiting_for_user_click', 'pid': os.getpid(),
                     'at': time.time(), 'version': VERSION, 'credentialsRead': False, 'networkStarted': False})
        root.after(500, self.poll)

    def post(self, message):
        self.updates.put(message)

    def manifest(self):
        with self.report_lock:
            processes = {name: proc.identity for name, proc in [('bridge', self.bridge), ('daemon', self.daemon), ('controller', self.controller)] if proc is not None}
            write_report(self.session, 'processes.json', {'schema': 1, 'sessionId': self.session.name,
                         'launcherVersion': VERSION, 'ui': os.getpid(), 'processes': processes,
                         'controllerDir': self.controller_dir.name if self.controller_dir else None,
                         'port': self.port, 'at': time.time()})

    def discover(self):
        """Only inspect this launcher's private manifest. Never adopt legacy PIDs."""
        if not (self.state / 'active-session.json').exists():
            return
        try:
            active = read_report(self.state / 'active-session.json')
            sid = active.get('sessionId')
            if not isinstance(sid, str) or not SESSION_NAME.fullmatch(sid):
                raise RuntimeError('Invalid session identity')
            session = self.state / 'sessions' / sid
            private_dir(session)
            manifest = read_report(session / 'processes.json')
            if manifest.get('schema') != 1 or manifest.get('sessionId') != sid:
                raise RuntimeError('Unverified or legacy process report')
            processes = manifest.get('processes', {})
            if not isinstance(processes, dict):
                raise RuntimeError('Invalid process ownership report')
            daemon = None
            if 'daemon' in processes:
                try:
                    daemon = OwnedProcess(processes['daemon'])
                except (FileNotFoundError, ProcessLookupError):
                    pass
            bridge = None
            controller = None
            if 'bridge' in processes:
                try:
                    bridge = OwnedProcess(processes['bridge'])
                except (FileNotFoundError, ProcessLookupError):
                    pass
            if 'controller' in processes:
                try:
                    controller = OwnedProcess(processes['controller'])
                except (FileNotFoundError, ProcessLookupError):
                    pass
            if daemon is None and bridge is None and controller is None:
                return
            self.session, self.daemon_dir = session, session / 'daemon'
            private_dir(self.daemon_dir)
            if daemon is not None:
                self.daemon = self.gate.adopt(daemon, 'daemon')
            if bridge:
                self.bridge = self.gate.adopt(bridge, 'bridge')
            if controller:
                self.controller = self.gate.adopt(controller, 'frontend')
            self.port = manifest.get('port')
            if daemon is None:
                self.status.set('The previous game daemon ended. An owned bridge/controller remains.\nUse Stop MCPBot to clean it up before starting a new game.')
            else:
                self.status.set('Existing owned game daemon found. No connection has been started.\nChoose Reattach Controller, Restart Controller, or Stop MCPBot.')
        except (OSError, ValueError, TypeError, RuntimeError, KeyError, IndexError):
            self.discovery_blocked = True
            self.status.set('An existing session report could not be safely verified.\nStart is blocked to avoid a duplicate connection; no process was signalled.')

    def spawn(self, arguments, role, *, cwd=BASE, proxy=False, stdout=subprocess.DEVNULL):
        def factory():
            child = subprocess.Popen([str(self.node), *map(str, arguments)], cwd=cwd, env=clean_env(proxy),
                                     stdin=subprocess.PIPE if role == 'frontend' else subprocess.DEVNULL, stdout=stdout, stderr=subprocess.DEVNULL,
                                     start_new_session=True)
            owned = OwnedProcess.spawned(child)
            # Ownership is recorded before releasing the gate. UI close cannot
            # leave a started daemon without a reopenable ownership manifest.
            name = 'controller' if role == 'frontend' else role
            setattr(self, name, owned)
            try:
                self.manifest()
            except BaseException:
                terminate(owned)
                setattr(self, name, None)
                raise
            return owned
        return self.gate.start(factory, role)

    def start(self):
        if self.session is not None or self.starting or self.stopped or self.closing or self.discovery_blocked:
            return
        self.starting = True
        sid = 'session-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:12]
        try:
            self.session = self.state / 'sessions' / sid
            private_dir(self.session)
            self.daemon_dir = self.session / 'daemon'
            private_dir(self.daemon_dir)
            private_dir(self.session / 'controllers')
            write_report(self.session, 'user-start.json', {'userActivated': True, 'at': time.time(),
                         'source': 'native_start_button', 'version': VERSION})
            self.manifest()
            write_report(self.state, 'active-session.json', {'sessionId': sid, 'at': time.time()})
        except (OSError, ValueError, RuntimeError):
            self.starting = False
            self.stopped = True
            self.status.set('Private session storage could not be prepared. Nothing was started.')
            self.refresh_buttons()
            return
        self.status.set('Starting one new private MCPBot game session…')
        self.refresh_buttons()
        threading.Thread(target=self.launch, daemon=True).start()

    def launch(self):
        try:
            # CONFIG is passed by path. No credential contents are opened here.
            # A regular file survives UI close; PIPE would tie bridge output to UI.
            log_path = self.session / 'bridge-events.jsonl'
            with open(log_path, 'xb', buffering=0) as output:
                bridge = self.spawn([self.bridge_program, '--config', self.config, '--proxy-from-env', '--port', '0'],
                                    'bridge', cwd=self.session, proxy=True, stdout=output)
            if bridge is None:
                return
            deadline = time.monotonic() + 30
            with open(log_path, 'r') as events:
                while not self.stopped and not self.closing:
                    if bridge.poll() is not None:
                        raise RuntimeError('Bridge exited before daemon startup')
                    line = events.readline()
                    if not line:
                        if time.monotonic() >= deadline:
                            raise RuntimeError('Bridge startup timed out')
                        time.sleep(0.1)
                        continue
                    try:
                        event = json.loads(line)
                    except (ValueError, TypeError):
                        continue
                    if event.get('state') in {'pair_closed', 'stopped', 'fatal'}:
                        raise RuntimeError('Bridge startup ended')
                    if event.get('state') != 'listening':
                        continue
                    port = event.get('port')
                    if not isinstance(port, int) or isinstance(port, bool) or not 1024 <= port <= 65535:
                        raise RuntimeError('Bridge returned an invalid loopback port')
                    self.port = port
                    daemon = self.spawn([BASE / 'minecraft-daemon.mjs', '--user-started-session', port,
                                         '--state-dir', self.daemon_dir, '--username', self.args.username], 'daemon')
                    if daemon is None:
                        return
                    self.post('Persistent game daemon started. Attaching its first controller…')
                    self.attach_controller()
                    return
        except Exception:
            # A frontend attach failure must not kill an established game daemon.
            if self.daemon is None:
                for process in self.gate.stop():
                    terminate(process)
                self.stopped = True
            try:
                write_report(self.session, 'launcher-error.json', {'error': 'launch_failed', 'at': time.time(), 'automaticRetry': False})
            except OSError:
                pass
            self.post('Launch could not complete. No reconnect or automatic retry was attempted.')
        finally:
            self.starting = False

    def attach_controller(self, restart=False):
        if self.stopped or self.closing or self.daemon is None or self.daemon.poll() is not None:
            return
        try:
            old = self.gate.detach()
            for process in old:
                terminate(process)
            if not self.gate.reopen_frontend():
                return
            deadline = time.monotonic() + 20
            while True:
                if self.stopped or self.closing or self.daemon.poll() is not None:
                    return
                try:
                    report = read_report(self.daemon_dir / 'session.json')
                    if report.get('state') == 'ready' and report.get('pid') == self.daemon.pid:
                        break
                except FileNotFoundError:
                    pass
                if time.monotonic() >= deadline:
                    raise RuntimeError('Daemon readiness timed out')
                time.sleep(0.1)
            private_dir(self.session / 'controllers')
            self.controller_dir = self.session / 'controllers' / ('controller-' + uuid.uuid4().hex)
            private_dir(self.controller_dir)
            write_report(self.controller_dir, 'user-attach.json', {'at': time.time(), 'source': 'restart_button' if restart else 'start_or_reattach_button', 'freshQueue': True})
            write_report(self.session, 'current-controller.json', {'controllerId': self.controller_dir.name, 'at': time.time()})
            controller = self.spawn([BASE / 'minecraft-client.mjs', '--attach', self.daemon_dir,
                                     '--state-dir', self.controller_dir, '--owner-stdin'], 'frontend')
            if controller is not None:
                self.post('Starting a fresh controller on the existing game daemon. Game login was not restarted.')
        except Exception:
            self.post('Controller attachment failed. The game daemon was left running. Use Reattach to try explicitly.')
        finally:
            self.controller_busy = False

    def reattach(self):
        if self.controller_busy or self.starting or self.stopped or self.closing or self.daemon is None:
            return
        if self.controller is not None and self.controller.poll() is None:
            self.status.set('A controller is already running. Use Restart Controller to replace only that frontend.')
            return
        self.controller_busy = True
        self.refresh_buttons()
        threading.Thread(target=self.attach_controller, daemon=True).start()

    def restart_controller(self):
        if self.controller_busy or self.starting or self.stopped or self.closing or self.daemon is None:
            return
        self.controller_busy = True
        self.status.set('Detaching the old controller, then attaching a fresh one to the same game…')
        self.refresh_buttons()
        threading.Thread(target=lambda: self.attach_controller(restart=True), daemon=True).start()

    def stop(self):
        if self.stopped:
            return
        # Snapshot first. Storage errors must never prevent stopping owned work,
        # and no in-flight spawn can escape this snapshot.
        processes = self.gate.stop()
        self.stopped = True
        if self.session is not None:
            try:
                if self.daemon_dir is not None:
                    write_report(self.daemon_dir, 'stop.request', {'source': 'native_stop_button', 'at': time.time()})
                write_report(self.session, 'user-stop.json', {'userActivated': True, 'at': time.time()})
            except OSError:
                self.post('Stop is still being applied, but its private report could not be written.')
        self.status.set('Stopping MCPBot, the owned daemon and bridge. No reconnect will occur.')
        self.refresh_buttons()
        # Stop controller first, daemon second (graceful game quit), bridge last.
        ordered = sorted(processes, key=lambda proc: 2 if proc is self.bridge else 1 if proc is self.daemon else 0)
        def finish():
            failed = False
            for process in ordered:
                try:
                    terminate(process)
                except (OSError, subprocess.TimeoutExpired):
                    failed = True
            self.post('A process could not be confirmed stopped; inspect the private process report.' if failed else
                      'MCPBot and this owned session have stopped. Close and reopen to start a new game.')
        threading.Thread(target=finish, daemon=False).start()

    def close(self):
        if self.closing:
            return
        self.closing = True
        processes, preserved = self.gate.close_ui()
        try:
            if self.session is not None:
                write_report(self.session, 'ui-closed.json', {'at': time.time(), 'gamePreserved': preserved and not self.stopped,
                             'frontendDetached': True, 'cancelledIncompleteStartup': not preserved})
        except OSError:
            pass
        def finish():
            for process in processes:
                try:
                    terminate(process)
                except (OSError, subprocess.TimeoutExpired):
                    pass
        # Non-daemon cleanup survives Tk destruction; persistent game processes
        # are excluded from the gate's close snapshot once daemon ownership exists.
        threading.Thread(target=finish, daemon=False).start()
        self.root.destroy()

    def refresh_buttons(self):
        unavailable = self.stopped or self.closing or self.discovery_blocked
        self.start_button.config(state='normal' if not unavailable and self.session is None and not self.starting else 'disabled')
        daemon_alive = self.daemon is not None and self.daemon.poll() is None
        controller_alive = self.controller is not None and self.controller.poll() is None
        can_attach = daemon_alive and not unavailable and not self.starting and not self.controller_busy
        self.attach_button.config(state='normal' if can_attach and not controller_alive else 'disabled')
        self.restart_button.config(state='normal' if can_attach and controller_alive else 'disabled')
        self.stop_button.config(state='normal' if not unavailable and self.session is not None else 'disabled')

    def poll(self):
        if self.closing:
            return
        while not self.updates.empty():
            self.status.set(self.updates.get_nowait())
        if self.daemon is not None and not self.stopped and not self.starting and not self.controller_busy:
            if self.daemon.poll() is not None:
                self.status.set('The game daemon ended. No automatic reconnect. Use Stop MCPBot to clean up its bridge.')
            else:
                try:
                    report = read_report(self.daemon_dir / 'status.json')
                    if time.time() - (self.daemon_dir / 'status.json').stat().st_mtime < 10:
                        backend = report.get('backend') or {}
                        game = backend.get('status') or {}
                        server = backend.get('server') or report.get('server') or {}
                        try:
                            server = read_report(self.daemon_dir / 'session.json').get('server') or server
                        except (OSError, ValueError, RuntimeError):
                            pass
                        attached = self.controller is not None and self.controller.poll() is None and report.get('controllerAttached')
                        controller_state = 'attached' if attached else 'detached; use Reattach Controller'
                        title = 'Controller ' + VERSION + ': ' + controller_state + '\nGame backend: ' + str(server.get('version', 'unknown'))
                        if game.get('ended') or report.get('backendEnded'):
                            self.status.set(title + '\nGame connection ended. Reattaching does not reconnect the game.')
                        elif game.get('ready'):
                            position = game.get('position') or {}
                            self.status.set(title + '\nMCPBot is connected. Health: ' + str(game.get('health')) + ' / 20   Food: ' + str(game.get('food')) + ' / 20\nPosition: ' + ', '.join(str(round(position.get(axis, 0), 1)) for axis in ('x', 'y', 'z')))
                        else:
                            self.status.set(title + '\nWaiting for the current game session; no sign-in retry.')
                except (OSError, ValueError, TypeError, RuntimeError):
                    pass
        self.refresh_buttons()
        self.root.after(1000, self.poll)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Open an MCPBot Start window without reading credentials or connecting.')
    parser.add_argument('--config', required=True, help='Private bridge configuration path; only the bridge reads it after Start')
    parser.add_argument('--bridge', required=True, help='Existing approved bridge.cjs')
    parser.add_argument('--node', default=shutil.which('node'), help='Node.js 22+ executable')
    parser.add_argument('--relay-label', default='relay.example.invalid')
    parser.add_argument('--username', default='MCPBot', help='Authorized offline Minecraft identity (1..16 letters, digits or underscores)')
    parser.add_argument('--state-dir', default=str(pathlib.Path(os.environ.get('XDG_STATE_HOME', pathlib.Path.home() / '.local/state')) / 'minecraft-mcp'))
    parser.add_argument('--check', action='store_true', help='Validate non-secret paths without opening UI, reading config, or connecting')
    args = parser.parse_args(argv)
    if not 1 <= len(args.username) <= 16 or not all(c.isascii() and (c.isalnum() or c == '_') for c in args.username):
        parser.error('--username must be 1..16 letters, digits or underscores')
    os.umask(0o077)
    if not args.node or not pathlib.Path(args.node).is_file() or not os.access(args.node, os.X_OK):
        parser.error('A usable --node executable is required')
    if not pathlib.Path(args.bridge).is_file():
        parser.error('--bridge must point to the existing bridge program')
    if args.check:
        print(json.dumps({'passed': True, 'version': VERSION, 'credentialsRead': False, 'networkStarted': False,
                          'userStartRequired': True, 'persistentGameDaemon': True,
                          'runtimeFilesPresent': all((BASE / name).is_file() for name in ['minecraft-daemon.mjs', 'minecraft-frontend.mjs', 'minecraft-client.mjs', 'minecraft-server.mjs', 'call.py'])}))
        return 0
    state = pathlib.Path(args.state_dir).expanduser().absolute()
    private_dir(state)
    private_dir(state / 'sessions')
    lock_path = state / 'ui.lock'
    descriptor = os.open(lock_path, os.O_CREAT | os.O_APPEND | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    lock = os.fdopen(descriptor, 'a')
    info = os.fstat(lock.fileno())
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise RuntimeError('Invalid UI lock')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    import tkinter as tk
    root = tk.Tk()
    Launcher(args, root, tk)
    root.mainloop()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
