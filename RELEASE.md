# Public candidate: 3.2.0-rc.1

This additive candidate builds on public main `5725756a8e2bec268e0de8cf05c173c2cfc3af3b`, including the merged open-wooden-door repair. It requires maintainer review and is not a deployment or real-server acceptance claim.

## Ecosystem integration

- Local read-only dashboard, server-authoritative inventory and real-time Prismarine 3D reconstruction, enabled only by an explicit new-session flag
- Conservative movement safety, bounded surfacing and a verified boat launch sequence with offline state/packet evidence
- Explicitly stepped session-only gather/storage/restock and simple-block schematic workflows with no retry/resume after uncertainty
- Reuse of Prismarine renderer/assets/schematic packages and a minimal MIT-licensed upstream state-machine core; full web-inventory and state-machine servers are deliberately excluded after dependency/lifecycle review
- Corrected evidence matrix, updated capability catalog and dedicated browser CI over a synthetic world

The candidate never restarts or hot-patches an existing game. It contains no private game memory, bridge implementation, real connection configuration, credentials or world state. IPC remains 1; version reporting distinguishes this source from earlier running backends. See docs/READONLY-OBSERVER.md, docs/WORKFLOWS.md and docs/COMPATIBILITY.md for exact limits.

## Functional foundation

- Server-authoritative inventory/cursor, crafting, exact-stack equipment and workstation checks
- Bounded serialized actions, no replay after uncertain outcomes, and persistent safety fences
- Consumption waits for inventory completion as well as hunger recovery
- Furnace transfer uses shared server-confirmed inventory operations
- Persistent single game daemon, restartable local controller, no automatic reconnect
- Neutral offline unit, stdio, protocol, queue and lifecycle fixtures

## Public-candidate changes

- Removed deployment-specific identities, endpoints, paths, private incident narratives and diagnostic result artifacts
- Renamed first-party runtime files to generic minecraft-* names
- Added validated configurable offline username (default MCPBot)
- Required explicit private gameplay state directory instead of a deployment path fallback
- Excluded arbitrary chat-regex registration/wait tools from the guarded runtime
- Native plugin initialization completes before verified methods are installed; method replacement fences mutations, and failed equipment setup cannot fall through to digging
- Queue state uses shared ancestor validation and unpredictable exclusive report writes
- Patched compatible dependency chains, upgraded vendored test tooling and omitted unused optional screenshot renderer dependencies; retained source licenses and documented remaining advisory limits
- Replaced documentation with Chinese/English quickstart, scope, authentication and validation limits
- Added explicit publication allowlist and regenerable checksum manifest; no inherited private Git history

Modified first-party code is identified by its existing change notices or this file. The upstream source component retains its original MIT license and notices. Dependency versions and any local vendor deviations are recorded in NOTICE and SECURITY.md.

See VALIDATION.json for completed checks. Boat use and full catalog behavior on a real server remain unvalidated. Public publication is separate from deploying or restarting any game session.
