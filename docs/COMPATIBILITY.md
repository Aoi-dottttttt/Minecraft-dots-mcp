# Runtime compatibility contract

Target: Minecraft Java 1.21.1, protocol 767, offline protocol identity through an authorized local server/bridge. Other versions, modded layouts, plugins and authentication routes are not certified by this candidate.

## Independent versions

- Package/backend version: currently 3.1.1-rc.2
- Frontend/controller version: currently 3.1.1-rc.2
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

The separate native `goto` and `get_path_to` tools do not use this helper and
are not changed. Tool names, descriptions, argument schemas, response format,
15-second default / 60-second maximum movement timeout, action serialization,
IPC and dependency locks are unchanged. Offline fixtures use the repository's
locked Minecraft 1.21.1 data and actual A*/collision/controller implementations;
they do not establish real-server acceptance of this implementation.

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

The native one-tick wait has a 5050 ms timeout. The serialized action lane stays
occupied until preparation settles; timeout or cancellation does not leave a
pending placement that can fire on a later tick. Server-authoritative block
confirmation, exact one-item debit requirements for placement provenance,
uncertainty fences and no automatic retry remain unchanged. An absent inventory
debit cannot grant provenance even when the block effect is confirmed.

The neutral offline fixture loads the actual locked physics, generic-place and
public place-block plugins. It verifies all six clicked-face centers, rotation
packet ordering, stalled ticks, pending non-forced turns, already-sent aim,
invalid angle history, cancellation/stale preparation and the existing
confirmation boundaries. It does not establish server acceptance, every
orientation-sensitive block's placement semantics, or live bed/boat behavior.
Tool schemas, package versions, IPC and dependency locks are unchanged.

## Change policy

Schema or semantic changes require a documented compatibility decision, regression fixture and maintainer review. Breaking tool/IPC contracts require a version boundary and migration notes. Do not infer compatibility solely from matching tool names or package version. The public candidate is 3.1.1-rc.2 so it cannot be confused with the historical base.

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
