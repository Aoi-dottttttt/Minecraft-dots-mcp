#!/usr/bin/env python3
"""Supported native viewer entry: bounded nonblocking file relay, no game connection."""
import argparse
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import time

MAX_BYTES = 16 * 1024 * 1024
STALE = b'{"schemaVersion":1,"status":"stale"}\n'

def private_directory(value):
    path = Path(value).absolute()
    for parent in (path, *path.parents):
        if parent.is_symlink(): raise ValueError('Symlinked data path rejected')
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Private user-owned data directory required')
    return path

def bounded_read(directory):
    directory = private_directory(directory)
    fd = os.open(directory / 'mesh-frame.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > MAX_BYTES:
            raise ValueError('Private bounded regular mesh file required')
        content = os.read(fd, MAX_BYTES + 1)
        if len(content) > MAX_BYTES: raise ValueError('Mesh exceeds bound')
        return content
    finally: os.close(fd)

def atomic_write(path, content):
    private_directory(path.parent)
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('Unsafe output destination')
    fd, temporary = tempfile.mkstemp(prefix='.native-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)  # Atomic replacement never follows a target link.
    finally:
        if os.path.exists(temporary): os.unlink(temporary)

class FrameRelay:
    """A FIFO/device/bad source cannot block Godot's independent expiry clock."""
    def __init__(self, source, mirror):
        self.source, self.mirror, self.last = source, mirror, None
    def update(self):
        try: content = bounded_read(self.source)
        except (OSError, ValueError): content = STALE
        if content != self.last:
            atomic_write(self.mirror / 'mesh-frame.json', content); self.last = content
    def close(self): atomic_write(self.mirror / 'mesh-frame.json', STALE)

def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True)
    parser.add_argument('--synthetic-fixture', action='store_true')
    parser.add_argument('--test-frames', type=int, default=0)
    args = parser.parse_args()
    if args.test_frames < 0 or args.test_frames > 18000: raise ValueError('Test frames must be 0..18000')
    directory = private_directory(args.directory)
    program = shutil.which('godot')
    if not program: raise RuntimeError('Godot is not installed; obtain explicit installation approval first')
    atlas = root / 'node_modules/prismarine-viewer/public/textures/1.21.1.png'
    if not atlas.is_file(): raise RuntimeError('Installed official atlas unavailable')
    os.umask(0o077)
    run = Path(tempfile.mkdtemp(prefix='native-view-', dir=directory))
    mirror = run / 'frames'; mirror.mkdir(mode=0o700)
    relay = FrameRelay(directory, mirror); relay.update()
    env = {key: os.environ[key] for key in ['PATH','DISPLAY','XAUTHORITY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','LANG','LC_ALL'] if key in os.environ}
    for key, name in [('HOME','home'),('XDG_CONFIG_HOME','config'),('XDG_DATA_HOME','data'),('XDG_CACHE_HOME','cache')]:
        path = run / name; path.mkdir(mode=0o700); env[key] = str(path)
    command = [program, '--path', str(root / 'runtime/native3d'), '--rendering-method', 'gl_compatibility', '--audio-driver', 'Dummy', '--', '--directory', str(mirror), '--atlas', str(atlas)]
    if args.synthetic_fixture: command += ['--synthetic-fixture']
    if args.test_frames: command += ['--test-frames', str(args.test_frames)]
    # Reject a pre-existing unsafe report before launching any process.
    metadata = directory / 'native-view-run.json'
    atomic_write(metadata, json.dumps({'runDirectory':str(run),'pid':None,'synthetic':args.synthetic_fixture,'state':'starting','networkRequests':False,'gameConnection':False}).encode())
    samples = []
    with (run / 'renderer.log').open('x') as log:
        child = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        try:
            atomic_write(metadata, json.dumps({'runDirectory':str(run),'pid':child.pid,'synthetic':args.synthetic_fixture,'state':'running','networkRequests':False,'gameConnection':False}).encode())
            while child.poll() is None:
                relay.update()
                try:
                    memory = Path(f'/proc/{child.pid}/statm').read_text().split()
                    fields = Path(f'/proc/{child.pid}/stat').read_text().rsplit(')',1)[1].split()
                    samples.append({'at':time.monotonic(),'rssMiB':int(memory[1])*os.sysconf('SC_PAGE_SIZE')/1048576,'cpuSeconds':(int(fields[11])+int(fields[12]))/os.sysconf('SC_CLK_TCK')})
                except (OSError,ValueError,IndexError): pass
                time.sleep(0.5)
        finally:
            try: relay.close()
            finally:
                if child.poll() is None:
                    child.terminate()
                    try: child.wait(timeout=5)
                    except subprocess.TimeoutExpired: child.kill(); child.wait()
    report = {'exitCode':child.returncode,'sampleCount':len(samples),'peakRssMiB':max((s['rssMiB'] for s in samples),default=None),'cpuSeconds':samples[-1]['cpuSeconds'] if samples else None,'observedSeconds':samples[-1]['at']-samples[0]['at'] if len(samples)>1 else 0,'synthetic':args.synthetic_fixture}
    atomic_write(metadata, json.dumps({'runDirectory':str(run),'pid':child.pid,'state':'closed','synthetic':args.synthetic_fixture,'gameConnection':False}).encode())
    atomic_write(run / 'resources.json', (json.dumps(report,indent=2)+'\n').encode())
    print(json.dumps({'runDirectory':str(run),**report}))
if __name__ == '__main__': main()
