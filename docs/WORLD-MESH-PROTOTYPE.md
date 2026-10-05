# Isolated file-only mesh prototype

This branch is not enabled by the runtime and is not part of the rc2 safety/Tk
release. No network service, browser, game connection, control file or game action
is created. Build with the existing locked dependencies; install nothing else.

An explicitly authorized caller can start `createWorldFileExporter` on its one
already-connected bot. Its private `world-frame.json` contains at most 17×13×17
cells read through synchronous `blockAt`, no entities/NBT/text, and a five-second
lease. Only an observed `spawn` permits live export by default. `initiallyReady`
requires the caller's existing spawn evidence; it is not a reconnect request.

The optional process is started explicitly:

```sh
node scripts/world-mesh-sidecar.mjs --directory /absolute/private/world-observer
```

`--once` converts one frame and exits without renewing its original lease. The
normal process checks the fixed source file every two seconds, with filesystem
notifications expediting stale/generation checks. Geometry is generated at most
once per two seconds, with only one in-flight conversion/write. The directory
must be owned by the current user with no group/other access. Both files are 0600;
output replacement uses an exclusive temporary file and atomic rename. Symlinks,
untrusted permissions and oversized input reject. The source is never changed.

## Mesh consumer contract

`mesh-frame.json` has:

- `schemaVersion: 1`, `sourceGeneration`, `sourceSequence`, `capturedAt`,
  `validUntil`, `status`, fixed `reason`, and `bounded: true`
- `position`, `yaw`, `pitch`, and `bounds: {origin, size}`
- `unknownCells` plus `unknownIndices` in y/z/x order, where
  index = (localY × 17 + localZ) × 17 + localX
- `estimatedTintCells` and `estimatedLightCells`, reporting missing source data
- `sections`, each with `offset: [sx,sy,sz]`, `positions`, `normals`, `colors`,
  `uvs`, and triangle `indices`, all plain JSON numeric arrays

Section offsets are the **original worker's section centres** (normally the
16-block section start plus 8). Add that offset to the original local positions;
do not add another 8 or reinterpret it as the minimum corner. UVs refer to the
installed official `prismarine-viewer/public/textures/1.21.1.png` atlas. Rendering
must preserve its vertex colours, atlas alpha and indexed triangle topology.
Actual native-client lighting/shaders are not reproduced or certified.

Consumers MUST clear meshes and show a stale/unknown overlay whenever status is
not live, the lease expires, the file disappears or parsing/validation fails.
Do not keep the previous dimension displayed as live. A producer crash cannot
write a final stale frame, so checking `validUntil` is mandatory. Do not renew
that time on reads. The normal sidecar rechecks the source after computation;
source-generation changes invalidate in-progress results. Closing waits for
old work and writes a final empty stale frame.

## Bounds and honesty

The original, fingerprint-checked `viewerAsset('worker.js')` adapter is reused in
a Node VM with no filesystem/network capabilities. This module does not change
renderer math. It reconstructs synthetic chunks from the fixed arrays and passes
only those chunks to the official geometry worker. The VM is an execution wrapper
for trusted pinned code, not a general untrusted-code security boundary.

Only vanilla Java 1.21.1 cell windows wholly within Y −64…319 are accepted. The
source has no dimension identity, so this is a bounded height-envelope contract,
not certification of every dimension/modded world. Unsupported height windows
are rejected instead of shifted, scaled, silently clipped or remapped.

Unknown cells and cells outside the sampled box use blank placeholders solely
inside meshing. This can expose cutaway faces along the crop/unknown boundary.
They are NOT observations of air, navigability, visibility or building ownership.
Show the explicit sampling boundary and unknown-cell mask; do not advertise a
complete world. Missing biomes use an internal plains tint placeholder; missing
light values use zero, with counts disclosed. No new chunk is requested.

Output is capped at 150,000 vertices and 16 MiB. Invalid geometry, timeouts,
oversized output or source/renderer errors produce empty stale geometry. The
model/texture source remains the official Prismarine package, not fabricated
placeholder cubes. Minecraft screenshots and live-server acceptance are not
claimed by these synthetic tests.

## Godot native consumer prototype

An installed Godot 4.6-compatible executable is required. This branch does not
install software, expose a network service or activate the backend exporter.
Use the supported Python entry, not a browser or a direct untrusted-file engine
argument:

```sh
python3 scripts/native3d-launch.py --directory /absolute/private/world-observer
```

The launcher reads regular private input files using `O_NOFOLLOW|O_NONBLOCK`,
checks ownership/mode/type/size, and atomically relays bytes into a new private
run directory. A FIFO/device/symlink, missing file or other read error yields a
stale marker instead of blocking the renderer's expiry clock. The original
`validUntil` is never renewed. The launcher owns only its Godot child. Its status
and resource reports use exclusive temporary files and atomic replacement;
existing unsafe report destinations reject rather than follow links.

The native scene retains the upstream positions, normals, colours, texture UVs
and indexed topology. It displays a cyan position marker, an amber crop boundary
and a magenta unknown-cell mask. Mouse dragging and wheel scrolling operate only
the local camera. A black stale overlay clears all meshes on invalid/expired
input or generation regression. Vertex/attribute lengths, indices, section-grid
centres and world-space bounds are checked before GPU submission. At most 0.5
block of model overhang is accepted outside the sampled box; larger models reject
rather than expand the observed world. This does not certify all block models.

The consumer targets 15 fps while live and 2 fps while stale. World sampling and
meshing remain capped at one update per two seconds. No characters, entities,
private item text, server chat, lighting shaders, native-client screenshots or
complete-world visibility are claimed. Cropped edges may expose cutaway faces.

### Neutral verification

- 18 TypeScript exporter/mesh fixtures, including real FIFO rejection and close
- 9 Python relay fixtures: preserved lease, unknown/error clear, nonblocking
  FIFO, symlink target preservation, bounds/mode checks and atomic outputs
- 15 Godot headless validation fixtures: JSON numeric types, expiry, fixed crop,
  unknown mask, geometry attributes/indices and out-of-crop vertex rejection
- Native Linux pixel inspection over the synthetic fixture confirmed official
  textures, changing geometry, local camera orbit, unknown/crop indicators, and
  the cleared stale overlay after the producer stopped

```sh
python3 scripts/test-native3d-relay.py
godot --headless --path runtime/native3d --script res://validate-fixture.gd
node scripts/native3d-fixture.mjs --directory /absolute/private/fixture --seconds 60
# In a second terminal while that neutral fixture is running:
python3 scripts/native3d-launch.py --directory /absolute/private/fixture --synthetic-fixture
```

Synthetic fixtures are clearly marked in the native window and never connect to
Minecraft. On one Mesa llvmpipe software-rendered Linux desktop, a 15-fps trial
observed 14–15 fps after startup, about 247 MiB peak Godot RSS and 46.65 CPU seconds
over 63.26 seconds including the final stale screen. A separate 80-second meshing
trial generated 40 approximately 5,100-vertex frames, averaged 208 ms/mesh,
peaked at 384 ms/mesh, used about 380 MiB RSS and 9.85 CPU seconds. These are
observed fixture measurements, not performance guarantees or live acceptance.
The subsequent 2-fps stale mode is a conservative idle cap, not separately
benchmarked here. The combined native reconstruction is heavier than the Tk
status window and remains an isolated, unshipped prototype.
