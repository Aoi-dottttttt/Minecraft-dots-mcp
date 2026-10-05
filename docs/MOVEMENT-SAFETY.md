# Guarded movement and boat workflow

These adapters reuse the locked Mineflayer 4.39.0, pathfinder 2.4.5 and
prismarine-physics implementations on the existing bot. They add no connection,
independent controller, automatic replay, block destruction or rescue daemon.
Offline fixtures are not real-server acceptance.

## Ordinary navigation

The guarded initial profile and plugin-provided profiles preserve existing
avoidance rules while prohibiting water, lava, bubble columns, aquatic plants
and waterlogged stepping targets. Digging, automatic opening, scaffolding,
parkour and free-motion shortcuts remain disabled. Infinite liquid dropdowns
are disabled, maximum drop stays at most two blocks, and falling-block/flow
protections are forced on even when a plugin attempts to relax them.

`move-to-position`, approach helpers and native `goto` use `moveAndVerify`.
It combines dry navigation with the existing conservative open-wooden-door
adapter. Native `goto.timeout` is now explicitly capped at 60 seconds. An already
wet player or oxygen at or below 10/20 rejects a new route;
unexpected water, low oxygen, cancellation, death or disconnect terminates the
route. It clears the goal and controls, waits for the actual path promise to
settle, then restores its owned policy and listeners. A later owner's profile
is never overwritten. Arrival still requires the requested goal to match the
observed position; this does not constitute an independent server-position ACK.

The bounded `set_goal`, `follow_entity` and `flee_from` waits monitor the same
water/oxygen hazards. `get_path_to` remains a conservative read-only dry-profile
estimate; it does not temporarily install the door adapter. Its `noPath` can
therefore differ from a subsequent verified doorway route. Short manual key
tools are still manual controls, not oxygen-aware swimming routes.

Navigation stops on an unexpected immersion; stopping controls does not make a
submerged player safe. There is no unattended rescue, route retry or automatic
shore selection. Inspect promptly and choose an explicit action.

## Explicit vertical water escape

`inspect-movement-safety` is read-only and reports oxygen, the dry-route hazard
and whether a clear bounded column is loaded. `surface-from-water` is an explicit
single action in the ordinary serialized lane:

- Default limit 5 seconds / 6 vertical blocks; maximum 8 seconds / 8 blocks
- Checks the player's full 0.6-block horizontal footprint and vertical sweep
- Accepts only source water and empty air, with two air layers at the surface
- Rejects unknown chunks, ceilings, currents, plants, bubble columns, vehicles,
  excessive lateral drift and dimension changes
- Uses only ordinary jump controls, releasing all keys on success, failure,
  timeout and cancellation
- Requires a fresh server-derived breath event at least 19/20, together with an
  observed head position in air, before reporting breath confirmation

Local physics movement or a pre-existing oxygen value alone is insufficient.
The result always states `dryLandConfirmed: false` and `automaticRetry: false`.
It does not establish shore access, safe landing, a persistent air pocket, or
reliable automatic swimming. Tight underwater passages may be unsupported even
where a human could swim through them.

## Deliberate boat lifecycle

`launch-boat` accepts a visible source-water block, optional exact item/slot,
optional `mount` (default false), and a bounded confirmation timeout. Ordinary
wood boats and bamboo rafts are supported; chest boats are excluded from this
workflow. It requires a clear loaded 3x3 source-water patch, headroom, reach and
an unobstructed first water ray hit. It will not clear the area or use another
entity to make space.

The adapter calls Mineflayer's public `activateItem` exactly once. It does not
use the native `placeEntity` helper, whose pinned boat branch performs an
additional item-use step and has a broad entity wait. Placement confirmation
requires one fresh raw nearby boat spawn plus a fresh exact one-item debit in
the selected authoritative slot, with every other slot conserved. Ambiguous
spawns, transient unrelated changes, a reversed debit, timeout or cancellation
after use establish an inventory uncertainty fence. There is no second use or
cleanup inventory click.

Optional mounting occurs only after placement evidence. A missing passenger
confirmation returns the existing boat ID and `mountConfirmed: false`; it never
replaces the boat or begins driving. Existing `mount_entity`, `steer_vehicle`
and `dismount` complete the separately requested lifecycle. Steering remains a
bounded input with movement observations, not navigation to a destination. It
stops on server detachment, vehicle change/removal or cancellation. Raw passenger
removal also repairs the pinned library's stale vehicle cache.

The pinned public vehicle API and synthetic movement packets do not establish
working boat physics on a real 1.21.1 server. Launch, ride, drive and land still
require separately authorized end-to-end real-server acceptance. No raw vehicle
movement packets, forced positions, physics bypasses or automatic dismounts were
added. A boat entity's proximity does not establish ownership.

## Evidence

- `tests/movement-safety.test.ts`: policy preservation, oxygen/water termination,
  explicit escape preflight, evidence, cancellation, cleanup and MCP lane drain
- `tests/verified-boat.test.ts`: raw spawn/debit gating, cancellation, ambiguity,
  transient corrections, ray target and optional mount outcomes
- `tests/survival-interactions.test.ts`: passenger-cache repair and bounded
  steering interruption/evidence
- `tests/special-terrain-navigation.test.cjs`: actual locked A* water avoidance,
  ladder planning, neutral ladder up/down physics, source-water vertical physics
- `tests/open-door-navigation.test.cjs`: existing doorway A*/controller/collision
  tests plus raised full-block and slab threshold rejection

Straight dry ladders retain the specifically tested planner/physics behavior.
Vines are not enabled. Raised/slab door thresholds remain rejected; the existing
same-height straight-door limitation has not been relaxed.
