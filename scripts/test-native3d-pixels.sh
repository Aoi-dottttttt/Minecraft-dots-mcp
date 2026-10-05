#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/native3d-pixels-XXXXXX")"
node scripts/native3d-fixture.mjs --directory "$DIRECTORY" --seconds 20 > "$DIRECTORY/fixture.log" 2>&1 &
fixture=$!
trap 'kill "$fixture" 2>/dev/null || true; wait "$fixture" 2>/dev/null || true' EXIT
python3 scripts/native3d-launch.py --directory "$DIRECTORY" --synthetic-fixture --verify-pixels
