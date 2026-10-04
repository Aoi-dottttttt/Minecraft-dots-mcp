#!/bin/sh
# Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
# Opens the local Start window; never starts a connection by itself.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 "$HERE/launch-ui.py" "$@"
