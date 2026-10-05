# Changelog

## 3.2.0-rc.1: bounded ecosystem integration candidate

- Add an opt-in, loopback-only status/inventory dashboard and Prismarine 3D reconstruction sharing the existing bot; drop all browser gameplay input and remove private text/NBT from observations
- Add conservative dry navigation and explicit oxygen/surfacing and boat-launch checks, with special-terrain fixtures; retain bounded actions, no automatic digging/building and no autonomous rescue claim
- Add session-local, explicitly stepped gather → storage → restock and bounded simple-block schematic plans, using a minimal MIT upstream state-machine core and `prismarine-schematic`; no automatic resume/replay or full autonomous farm/builder claim
- Correct workstation evidence labels and remove the disabled screenshot recommendation from the map tool
- Pin observation dependencies, retain all upstream notices, and add HTTP/socket/worker and synthetic-browser CI checks

This is a source/PR candidate. It has not been merged, installed into a live backend, or accepted on a real server. IPC remains version 1; existing backend code is unchanged until the user explicitly starts a new authorized session. See VALIDATION.json and exact-commit CI for completed and blocked checks.

## 3.1.1-rc.2: verified maintenance candidate

- Verify detach cancellation across both IPC rejection and settled backend inventory-fence rejection, with no-motion and no-extra-click assertions
- Allow verified movement through consistently open wooden doors using a scoped
  first-party pathfinding adapter, retaining real collision shapes and straight
  entry/exit only; add locked-dependency A*/physics/controller regressions

- Extend one-action furnace fuel conservation to birch planks in ordinary furnaces with an exact 300-tick duration; preserve cursor, other-slot, fresh-progress and single-burn evidence requirements
- Record session-local placement provenance for both native placement and generic block use only with an empty target, matching held block, raw block update and exact one-item server debit; expire records after block removal/replacement, dimension or chunk continuity changes
- Propagate cancellation through equipment selection, crafting clicks and book-edit preparation; retain a fence after a submitted inventory action is cancelled
- Add bounded, read-only `read-book` pages from authoritative player inventory, with untrusted text labels and stable pagination
- Preserve no-food auto-eat preflight rejection without sending gameplay packets or setting an inventory fence
- Permit only validated plain `send-chat` through an existing inventory fence while preserving serialization, live-session checks, safety-stop gates and the fence itself
- Retain an already supplied `NODE_EXTRA_CA_CERTS` path only for the external bridge child, without changing certificates or disabling TLS verification
- Preserve the merged frontend transport uncertainty fix from PR #1; improve controller response-loss startup diagnostics without weakening its queue, no-retry or no-reconnect assertions

This source candidate requires maintainer review and an explicitly started new backend session before runtime changes take effect. See VALIDATION.json for observed verification and limitations.

## 3.1.1-rc.1: shared-maintenance candidate

- Generic per-installation bot identity and local configuration/state boundaries
- Consistent minecraft-* runtime names and Chinese/English quickstart
- Guarded runtime excludes arbitrary chat regex tools
- Native plugin initialization barrier and mutation guard-integrity/cancellation regressions
- Controller state path validation and exclusive randomized report writes
- Contributor/agent guidance, sanitized bug and PR templates, offline CI checks
- Explicit frontend/backend compatibility, reviewed release and rollback guidance
- Publication file allowlist and reproducible source checksums

Publication, independent security clearance and real-server acceptance are pending. This does not upgrade any existing game session. See VALIDATION.json and SECURITY.md.

## 3.1.0-dot.2 functional base

Persistent daemon with restartable single-controller IPC; no automatic reconnect/replay; server-authoritative inventory, crafting, exact-stack equipment, consumption and furnace transfer checks. Detailed behavioral boundaries are in INTEGRATION.md. No private deployment history is included.
