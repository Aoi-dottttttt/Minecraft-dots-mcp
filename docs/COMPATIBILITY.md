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
