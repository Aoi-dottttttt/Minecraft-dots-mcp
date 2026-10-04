# Public candidate: 3.1.1-rc.1

This history-free public source candidate preserves the functional foundation of version 3.1.0-dot.2 and adds publication hardening. It is not a claim of complete real-server acceptance.

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
