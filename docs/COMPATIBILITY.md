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
