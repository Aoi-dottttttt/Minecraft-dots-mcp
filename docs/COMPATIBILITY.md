# Runtime compatibility contract

Target: Minecraft Java 1.21.1, protocol 767, offline protocol identity through an authorized local server/bridge. Other versions, modded layouts, plugins and authentication routes are not certified by this candidate.

## Independent versions

- Package/backend version: currently 3.2.0-rc.3
- Frontend/controller version: currently 3.2.0-rc.3
- Local IPC protocol version: 1, checked during attachment
- Tool schemas: CAPABILITIES.json, regenerated from the networkless fixture

The backend reports its actual loaded version, process and session identity. A new frontend can attach only to a compatible IPC session. Updating frontend files never hot-patches Mineflayer, action code or inventory authority already loaded in the backend. Backend changes require an explicit new session.

The initial generic candidate renames runtime paths and private namespace fields. It is not promised to attach to older personalized controller state. Start a fresh approved session for the generic release; never migrate old queues or clone runtime state between players.

## Frontend transport failures

Once the frontend attempts to write a `call` to the daemon, a transport error,
invalid-JSON/oversized frame, timeout or connection close before a complete
response leaves the outcome unknown. The tool error reports `uncertain: true`
and `automaticRetry: false`, and the file-queue controller fences later actions.
This does not assert that the backend executed the call. Explicit daemon
rejections retain their reported uncertainty; local validation or frame-encoding
failures before dispatch remain `uncertain: false`. Read-only IPC status/list
failures do not acquire a gameplay uncertainty flag merely because a call was
pending on the same socket.

This is a conservative frontend error-classification fix within IPC version 1;
tool schemas, backend code and existing backend fences are unchanged. It does
not reconnect, replay requests, restart a backend or update a running session.

## Open wooden doors in verified movement

`move-to-position` and the block-tool approach actions using `moveAndVerify`
recognize consistently open, matching wooden-door halves with real collision
shapes leaving a central 0.6-block-wide corridor. A temporary first-party
adapter corrects pathfinder 2.4.5 planning metadata and post-processed door
waypoints. It preserves the existing movement policy's avoidance/exclusion
rules, permits only same-height straight entry/exit, checks adjacent swept
body cells to reject corner cutting, and retains real world collision boxes. It never opens doors, digs, places blocks or changes entity
position. Its listener and owned movement policy are restored only after the
underlying `goto` settles, including cancellation and timeout; later replacement
policies are not overwritten.

Closed, inconsistent or unfamiliar door states/shapes, iron/copper doors and
sideways/diagonal crossings remain blocked. Raised/slab thresholds and modded
doors are outside this repair. A door closing after planning is still a real
physics obstacle; the next search rejects it. The adapter does not add automatic
reopening or change upstream block-state invalidation.

Since 3.2.0-rc.1 the native `goto` also uses this helper, with a maximum 60-second
timeout and the conservative dry/oxygen movement policy. `get_path_to` remains
a read-only dry-profile estimate without the temporary door adapter, so its
`noPath` may differ from verified `goto`. The existing action serialization and
IPC remain unchanged; additive tool schemas and dependency locks are published
with this candidate. See [movement safety](MOVEMENT-SAFETY.md). Offline fixtures use the repository's
locked Minecraft 1.21.1 data and actual A*/collision/controller implementations;
they do not establish real-server acceptance of this implementation.

## Additive ecosystem candidate (3.2.0-rc.3)

IPC remains version 1. New session-only workflow tools and the optional
`--observe-port` startup flag are additive. `get-session-status` adds an `observer`
field (`null` when disabled). An already running backend does not acquire new
flags, tools or dependencies by replacing a frontend. Launching the observer
requires a new explicitly authorized backend startup; no automatic migration,
controller replay, listener exposure or deployment is performed.

The observer uses the existing bot, binds only `127.0.0.1`, filters sensitive text
and block-entity/item NBT, and cannot dispatch gameplay. Bounded workflows retain
existing authority/fence rules and add revision-checked, one-batch-at-a-time plans.
See [observation](READONLY-OBSERVER.md) and [workflows](WORKFLOWS.md).

## Own-player air correction (3.2.0-rc.2)

Guarded reports add `oxygenEvidence`; `oxygen` can be null until raw metadata
for the current player has been observed. Unattributed upstream breath/cache
values are not evidence. Existing numeric consumers must handle unknown rather
than substitute full air. This is a safety correction within IPC 1; it requires
a newly started backend, and does not authorize automatic rescue or reconnect.

## Native file observation (3.2.0-rc.3)

`--observe-world-files` is an additive default-off boolean startup flag.
`get-session-status` adds `worldObserver` (null when disabled). The loaded-cell
file and mesh schemas are each version 1 and retain an absolute five-second
observation expiry. They are read-only outputs, not gameplay IPC or controls.
Godot is an optional separately installed graphical dependency; it is not bundled
or started by the backend. Existing sessions are not hot-upgraded.

## Change policy

Schema or semantic changes require a documented compatibility decision, regression fixture and maintainer review. Breaking tool/IPC contracts require a version boundary and migration notes. Do not infer compatibility solely from matching tool names or package version. The public candidate is 3.2.0-rc.3 so it cannot be confused with the historical base.

## Verification boundaries

Aliases increase catalog size without adding independent abilities. Offline protocol tests establish synthetic behavior only. Boat placement/riding, full tool catalog behavior and real-server/plugin compatibility remain unvalidated. Publish only the exact test scope observed.

## Verified maintenance behavior

Auto-eat resolves its eligible food before crossing the mutation boundary; no-food rejection sends no item-use cleanup and does not create a new fence. After attempted consumption, exact server confirmation and uncertainty fencing remain required. Only the exact ordinary `send-chat` tool can pass an inventory-authority fence. It remains a serialized mutation behind the live, controller, safety-stop, validation and rate gates; it does not clear the fence or enable aliases, commands, movement or inventory actions. DEL and all C0 controls are rejected.

The external bridge child preserves an already supplied `NODE_EXTRA_CA_CERTS` path only when the explicit proxy environment is enabled. It does not create certificates, change trust stores or disable TLS verification. Unsafe Node injection variables remain excluded.

The furnace consumption exception covers coal/charcoal and, newly, `birch_planks` with duration property 300 in an ordinary furnace. It needs an initially unlit furnace, one fresh ignition, fresh cooking progress, exact cursor debit and all other slots conserved. Smoker/blast-furnace birch planks, unreviewed fuels, remainders and re-ignition retain strict slot confirmation. This does not clear an existing inventory fence or authorize retries.

Constructed-block mining and native smelting consult one session-local placement ledger. Native `place-block` and adjacent `use-item-on-block` placement can record a source only after an originally empty target becomes the held block by raw server update and authoritative inventory proves exactly one item was spent without unrelated changes. A caller's expectation or success text is insufficient. `use-item-on-block` may report its block effect confirmed but `placementRecorded: false` if the additional provenance evidence is absent. No history/log import or user-supplied ownership override exists.

Records expire after observed removal/replacement, respawn, disconnect, dimension mismatch, or relevant full-chunk replacement/unload. Neighbor-connection state changes of the same continuously observed block can retain the record. A new session starts with no remembered ownership, and this remains evidence of our placement rather than proof of legal ownership or server permission.

`read-book` reads only authoritative player inventory slots 9–45, defaulting to the selected main hand. It never queries another container, issues packets or clears fences. Modern book components and legacy NBT text are decoded offline; signed rich text is returned only as a plain-text projection. Output carries the slot/inventory revisions and a content digest. Pages and characters are bounded, truncated output is explicit, and `expectedBookVersion` prevents combining pages from different revisions. Book content is untrusted player data and cannot authorize actions.

Cancellation is propagated to the underlying equipment/crafting operation, including book-edit equipment selection. A cancellation after a submitted inventory click retains uncertainty and never performs cleanup clicks or repeats the operation automatically. A stopped write-book operation must not start a later edit after cancelling its equipment preparation.

## Unreleased reactive-defense patch

IPC remains version 1. The additive `self-defense-enable`, `self-defense-disable`
and `self-defense-status` tools and the `get-session-status.selfDefense` field
exist only in a backend that actually loaded this patch. Defense is off at each
startup. Disable/status may pass the broker's busy/fence gate; enable retains all
normal controller, connection and mutation gates. The action scheduler preserves
settlement and adds bounded-fair priority for coalesced defense pulses.
See [self-defense](SELF-DEFENSE.md) for bounds and unvalidated cases. No backend,
frontend, configuration or connection is automatically upgraded or restarted.

### Ranged-defense V2 semantics

The status object identifies `implementation: "ranged-defense-v2"`. Additive
fields report `shieldRequestActive`, `shieldEffectConfirmed: false`, alerts,
step requests and the renewable quiet-lease remainder. `guarding` is an added
state. A no-route condition no longer permanently disables defense: bounded
passive guard continues while new server damage or a still-visible, valid already-attributed threat renews its eight-second lease. Visibility renewal never claims another damage event or successful shield effect.
Attack/movement budgets never reset within that encounter. A 2.5-second
physics/queue-update watchdog, explicit disable, stop, lifecycle change or an
inventory fence releases item use and prevents old queued work from restarting.
Prepare the hotbar weapon and off-hand shield before enabling: V2 never performs
a storage equipment swap in response to damage. This changes tactical semantics
without changing IPC version or enabling an old backend automatically.

## Java 1.21.1 wool and bed dye alternatives

The locked minecraft-data 3.117.0 / prismarine-recipe 1.5.0 combination keeps
only the first source-color alternative in each wool/bed dye recipe. For
example, cyan dye resolves only with black wool or black bed. Vanilla Java
1.21.1 instead enumerates all **15 other colors**, excluding the output color.
The complete wool/beds tags must not be substituted because they include that
illegal same-color input.

A first-party adapter verifies an existing resolved shapeless recipe from
`recipesAll`: two one-item inputs, one output, no remainder or table, exact
registered IDs and a -1/-1/+1 delta. It constructs only the missing alternatives
through the same installed `Recipe` constructor, without changing templates or
the global registry. The adapter is limited to exact version 1.21.1 and the
32 wool/bed outputs. `list-recipes`, `get-recipe`, `can-craft` and `craft-item`
share these concrete alternatives; unrelated and normal shaped bed recipes
remain unchanged. There is no general raw-recipe execution fallback.

Execution continues through `craftVerified`, never optimistic `bot.craft`.
Authoritative ingredient/cursor/grid/output confirmation, space checks,
serialization, cancellation, uncertainty fences and no automatic retry remain
in force. Each batch step reselects from current inventory; an output cannot
become a same-color input in the next step. Tool schemas, IPC, package versions
and dependency locks are unchanged. Datapacks or plugins overriding vanilla
recipes and other Minecraft versions are outside this compatibility repair.

Recipe rules were checked as static JSON inside the official
[Mojang 1.21.1 server distribution](https://piston-data.mojang.com/v1/objects/59353fb40c36d304f2035d51e7d6e6baa98dc05c/server.jar)
(SHA1 `59353fb40c36d304f2035d51e7d6e6baa98dc05c`), at
`data/minecraft/recipe/dye_<color>_{wool,bed}.json`. The archive was not executed.
`tests/tagged-dye-recipes.test.ts` covers all 480 legal input/output pairs,
32 same-color refusals, read/execution agreement, split stacks, malformed
resolved templates and the existing authoritative safety barriers using only
neutral synthetic packets. These tests do not establish real-server acceptance.


## Native placement rotation ordering

`place-block` aims at the exact center of the clicked reference face used by
Mineflayer 4.39.0's public `placeBlock`, then waits for one native physics tick.
A forced look changes local rotation immediately; it does not itself write the
rotation packet. The tick's synchronous position/look write completes before
placement resumes. In this pinned version, a zero local angle delta returns
before the forced-look branch, so an earlier non-forced turn can still be in
flight. Only in that case, two standard forced public look calls turn by
0.01 radians (less than one degree) and back to the exact face before the tick.
Both complete in microtasks without an intermediate rotation packet. The adapter
verifies that these turns changed finite local angles and that the final aim
rounds to zero under Mineflayer's own 0.15-degree quantizer; extreme or invalid
poses fail closed. Cancellation between preparation steps starts no cleanup
turn or placement. No raw movement packet, arbitrary sleep, vendor patch,
physics-speed change or second placement attempt is introduced.

After navigation and again after that tick, placement checks the bot session,
held item/type/count and selected slot, inventory window, reference block
identity/state, loaded empty target, player overlap, visibility and a conservative
4.5-block eye-to-clicked-face reach limit. A disconnect/respawn, dimension change
during aiming, or a changed player position, height, eye-height or rotation
at the final recheck, cancels placement. This deliberately requires a stationary,
stable pose: a moving/falling player must settle and be inspected before another explicit
attempt. Matching the clicked point and retaining that pose ensure the public
`placeBlock`'s internal look does not initiate a second turn after these checks.

The native one-tick wait has a 5050 ms timeout; the integrated guarded runtime
overrides this with its 5100 ms bounded tick wait. The serialized action lane stays
occupied until preparation settles; timeout or cancellation does not leave a
pending placement that can fire on a later tick. Server-authoritative block
confirmation, exact one-item debit requirements for placement provenance,
uncertainty fences and no automatic retry remain unchanged. An absent inventory
debit cannot grant provenance even when the block effect is confirmed.

In V2, damage requesting defense during pre-placement aiming is checked before
submitting the public `placeBlock` call, so an unsubmitted placement stops.
Damage after submission does not abort the critical operation: its block and
inventory evidence settles first, then defense may acquire the shared lane.
Neither case retries or resumes construction automatically.

The neutral offline fixture loads the actual locked physics, generic-place and
public place-block plugins. It verifies all six clicked-face centers, rotation
packet ordering, stalled ticks, pending non-forced turns, already-sent aim,
invalid angle history, cancellation/stale preparation and the existing
confirmation boundaries. It does not establish server acceptance, every
orientation-sensitive block's placement semantics, or live bed/boat behavior.
Tool schemas, package versions, IPC and dependency locks are unchanged.


## Supported partial-block arrival

Verified movement first checks the unchanged floored physical position. If that
fails, it accepts the pinned pathfinder's raised planning cell only for grounded
feet supported by the current loaded block's non-empty collision geometry.
Farmland, bottom slabs and unobstructed lower stair treads can therefore finish
an already-satisfied empty-path search without a `goal_reached` event. Support
requires positive player-footprint overlap and collision-contact tolerance only;
airborne, missing/empty geometry, vertical gaps, intersecting stair risers and
wrong goal cells remain unconfirmed. This is not an increased goal radius.

An accepted raised-cell completion clears the pathfinder goal only when it is
still this operation's goal, preventing the next physics tick from starting the
same empty path again without cancelling a newer goal. Existing cancellation,
timeout, action-lane settlement and door-policy restoration remain unchanged.
The fallback preserves a replacement goal's identity, but the pre-existing
movement-policy cleanup can reset controls if that replacement still uses the
temporary policy; this patch does not redesign external goal handoff.
In this rc.3/V2 integration all helper callers are affected, including native
`goto`. Dry-route, oxygen, cancellation and defense-interruption checks remain
in force. Tool and
IPC schemas, dependency locks, package versions and physics are unchanged.
Offline pinned-plugin fixtures do not establish live-server acceptance.

