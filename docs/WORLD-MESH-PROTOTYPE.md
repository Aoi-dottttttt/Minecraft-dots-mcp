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
