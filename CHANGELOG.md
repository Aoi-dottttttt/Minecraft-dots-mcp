# Changelog

## Unreleased reviewed fix integration

- Integrate Java 1.21.1 wool/bed dye alternatives from PR #6, retaining exact inventory confirmation
- Integrate native placement rotation ordering and stale-pose checks from PR #7, preserving rc.3/V2 navigation cancellation
- Integrate supported partial-block completion from PR #8 while preserving dry-land/oxygen guards, native goto coverage and V2 interruption ownership
- Add cross-version fixture coverage for waterlogged refusal, aborted navigation and policy restoration
- Refuse an unsubmitted placement when V2 defense is requested during aiming; retain critical confirmation after submission

## Unreleased: ranged-defense V2 review patch

- Replace one shield pulse followed by permanent disable with renewable eight-second quiet leases (including visible already-attributed threats after successful blocks), continuous server-attributed facing and a 2.5-second pulse-loss watchdog
- Keep active combat bounded to 12 seconds/16 attacks and movement to three fully loaded same-level steps inside a four-block origin leash; no digging, placement, doors, jumps, liquids, ladders or blind pursuit
- Use ordinary backwards/sideways controls while keeping the shield aimed at the source instead of allowing pathfinder to turn away during retreat
- Select only an already held/observed hotbar weapon under damage; require equipment preparation before enable rather than performing storage swaps mid-combat
- Accept only same-item/count/components, fresh server-confirmed monotonic wear on unrelated armor slots during verified equipment transfers; preserve all transferred-slot, cursor and fence checks
- Expose shield requests separately from effect confirmation, source uncertainty, multiple attackers, shield cooldown/breakage, armor loss and exhausted escape options
- Add deterministic before/after regressions, pinned protocol shield packets and locked-physics directional fixtures; V2 live effectiveness remains unvalidated

## Unreleased: bounded reactive self-defense review patch

- Add explicit session-only enable/disable/status controls, default off, using server damage-source evidence and a strict protected-target filter
- Run bounded verified equipment, cooldown melee, shielding and conservative observed-route retreat on the existing shared action lane
- Interrupt only safe navigation/movement/dig scopes; drain inventory and submitted placement, report interrupted construction, preserve fences and never replay
- Give manual stop/lifecycle invalidation priority and reject stale queued enables; distinguish observed target death from disappearance
- Add offline regressions and document unvalidated live combat and deployment requirements in `docs/SELF-DEFENSE.md`

## 3.2.0-rc.3: optional bounded native 3D reconstruction

- Add a default-off `--observe-world-files` startup flag on the existing bot, exporting only a private, bounded set of loaded block states/light/biomes every two seconds
- Reuse the pinned official Prismarine geometry and atlas in a file-only Godot view with local camera controls, crop/unknown indicators, and enforced stale clearing
- Bound file sizes, vertices and cadence; reject links, special files and out-of-range geometry; preserve the original observation lease through all consumers
- Add source/privacy guards, real FIFO regressions and synthetic native pixel CI with an exact SHA-pinned official Godot build
- This is a limited reconstruction, not a native Minecraft client screenshot, full-world viewer or proof of live swimming/workflow acceptance

## 3.2.0-rc.2: own-player air evidence and native status window

- Fix oxygen provenance: the pinned entity plugin can report other entities' air as the player's. Guarded navigation, surfacing and reports now use raw current-player protocol metadata only, with explicit unknown/age/revision information and lifecycle invalidation
- Add a file-only Tk status/inventory window using existing authoritative reports and official item textures. It starts no connection and shows stale or unverified observations explicitly
- Add locked-plugin/protocol regression coverage and native parser safety fixtures; retain all reachability and exact-inventory guards
- This candidate is separate from deployment. Swimming/boats and gather closed-loop acceptance remain unestablished; native 3D is not included

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
