# Modified for the public-candidate release; see RELEASE.md.
# Modified for 3.1.1-rc.1 release (2026-10-04). See RELEASE.md.
"""Serialize owned process creation with whole-session Stop and frontend detach."""
import threading


class ProcessGate:
    def __init__(self):
        self._lock = threading.Lock()
        self._closed = False
        self._frontend_closed = False
        self._processes = []

    def start(self, factory, role='persistent'):
        with self._lock:
            if self._closed or (role == 'frontend' and self._frontend_closed):
                return None
            process = factory()
            self._processes.append((role, process))
            return process

    def adopt(self, process, role):
        """Register an already ownership-verified process; never spawn or connect."""
        return self.start(lambda: process, role)

    def detach(self):
        with self._lock:
            self._frontend_closed = True
            return tuple(process for role, process in self._processes if role == 'frontend')

    def reopen_frontend(self):
        with self._lock:
            if self._closed:
                return False
            self._frontend_closed = False
            return True

    def close_ui(self):
        """Freeze spawning. Preserve a registered game daemon, else cancel startup.

        The daemon's factory runs under this same lock: closing during its spawn
        either captures it as persistent or blocks that spawn entirely.
        """
        with self._lock:
            self._closed = True
            self._frontend_closed = True
            persistent = any(role == 'daemon' for role, _ in self._processes)
            return (tuple(process for role, process in self._processes
                          if not persistent or role == 'frontend'), persistent)

    def stop(self):
        with self._lock:
            self._closed = True
            self._frontend_closed = True
            return tuple(process for _, process in self._processes)
