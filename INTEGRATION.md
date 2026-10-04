# Integration scope and limitations

The guarded runtime reuses tool modules from awesome-mineflayer-mcp 1.3.2 (commit 89a407ca18a4a39196c6ebe726d5208cff88a9e5) on one existing Mineflayer bot. It does not start upstream BotManager or a second identity. The root Apache-2.0 base and vendored MIT code retain their respective notices.

## Implemented families

Observation, bounded movement/look/pathfinding, mining/placement, inventory and crafting, containers/furnaces, block interaction, consumption, farming, non-player combat, sleep, fishing, workstation operations, chat, signs/books, event observation and waypoints have code paths and offline coverage of varying depth. CAPABILITIES.json records registered schemas, not validated independent abilities. Aliases are included in that count.

## Guarded entrypoint only

The integrated runtime excludes raw packets, arbitrary code/commands, creative/admin tools, alternate connection controls, automatic reconnect, physics bypasses and caller-supplied chat regex tools. It shares a serialized action lane and requires fresh server inventory/cursor evidence. Uncertain mutations create a fence. A new frontend cannot clear backend fences or replay old actions.

Typed ordinary player commands remain bounded in the adapter; they are not permission to use commands on a server. Item or block type alone does not establish ownership or whether a block was naturally generated. Runtime checks supplement, but cannot replace, the user's authorization and server rules.

These statements do not cover the legacy dist/main.js or the vendored standalone application, which expose different policies and surfaces. See SECURITY.md.

## Effect evidence

A completed request does not automatically mean a confirmed game effect. Some native book/item/entity effects, chat delivery, hotbar selection and daytime respawn attempts lack authoritative effect confirmation. Fishing separates cast/bite/reel and does not claim a caught item without inventory evidence. Schematic maps are not native screenshots.

Boat placement, riding and steering are not live-validated and must not be advertised as working. Mount and interaction tools being present is not end-to-end evidence.

Vanilla window layouts are supported where known. Unknown/modded layouts may be inspectable but unsafe slot mutations are rejected. Inventory packets arriving before an open-window packet are not accepted as confirmation. Minecraft versions other than 1.21.1 and server plugins/mods require separate compatibility verification.

## Validation boundaries

See VALIDATION.json for exact checks. All included tests use neutral synthetic data; no real server, account or world was used for this public candidate. Neither installation, a successful build, tool count nor a new frontend proves that an existing game backend has changed. Observe its reported loaded version and actual results before stating otherwise.
