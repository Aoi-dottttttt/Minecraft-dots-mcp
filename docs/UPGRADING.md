# Reviewed upgrades and rollback

There is no automatic updater. The shared repository helps contributors reuse fixes; it does not authorize installing every pull request or taking over another player's session.

## Before upgrading

1. Choose a maintainer-reviewed commit/tag and inspect its release notes, hashes, license/dependency changes and validation limits
2. Back up valuable worlds using the server owner's authorized process; keep configuration and credentials outside the source tree
3. Install into a new version directory using both lockfiles and run offline checks
4. Confirm which component changes: frontend-only or game backend

## Activate safely

For frontend-only changes with a compatible IPC contract, stop/detach the current controller and attach a new controller using a fresh private directory. Continuous control is stopped, but the game remains online and the player remains vulnerable.

For backend or dependency changes, wait until the user authorizes a normal game exit and new session. Do not force a disconnect for a code update. Start once using the intended local port and identity, then inspect the actual reported backend version and observed game state.

Never replay a previous queue, clear a safety fence by editing files, duplicate an uncertain item action, or use a second identity to test the same account. A lost response is not proof of failure.

## Roll back

Stop only the new owned session with the user's authorization. Select the last reviewed version in its separate directory for the next explicit start. Use a fresh state/controller directory. Do not restore runtime request ledgers or credentials from a public artifact.

## Release checklist

- Maintainer approval of the precise commit and intended distribution
- Fresh build/type/lint/unit/stdio/protocol/IPC/lifecycle checks on that commit
- Privacy scan, dependency advisory review, retained Apache/MIT notices
- Explicit declaration of skipped tests and known limitations
- Source allowlist/checksums verified; clean initial history for first publication
- Distinct version/tag, changelog and compatibility/migration notes
- No deployment or collaborator changes unless separately authorized
