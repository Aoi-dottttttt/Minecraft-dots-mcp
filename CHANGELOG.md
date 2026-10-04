# Changelog

## Unreleased

- Allow verified movement through consistently open wooden doors using a scoped
  first-party pathfinding adapter, retaining real collision shapes and straight
  entry/exit only; add locked-dependency A*/physics/controller regressions

- Preserve uncertainty for dispatched frontend calls when the daemon transport
  fails before a response, without retrying or restarting the backend
- Add synthetic transport-failure and controller queue-fencing regressions;
  explicit daemon rejection and pre-dispatch validation remain certain failures

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
