# Security and privacy boundary

## Supported guarded surface

The integrated runtime is runtime/minecraft-daemon.mjs with minecraft-frontend.mjs and optionally minecraft-client.mjs. It uses one bot, a private Unix socket, private user-owned local state, a single active controller, bounded requests, serialized actions, permanent uncertainty fences and no automatic reconnect/replay. It is designed for trusted local use, not an internet-facing service or a hostile multi-user machine.

The legacy dist/main.js and vendored standalone entrypoints expose different, broader policies. In particular, legacy chat does not inherit all integrated slash-command restrictions. Never assume the guard applies merely because a module is stored in this repository.

Caller-supplied regex registration and regex-based message waits are excluded from the guarded catalog to prevent synchronous regex work from blocking gameplay control. Controller state rejects symlinked/untrusted ancestors; reports use unpredictable exclusive temporary files. Same-user malware or an administrator can still compromise a local process and is outside this boundary.

## Authorization and untrusted content

Only use accounts, servers and worlds that the user is allowed to control. Local offline Minecraft identity is not Microsoft authentication or a whitelist bypass. A separate bridge may authenticate independently and is not bundled or audited here. Never send credentials in MCP arguments, chat or command lines.

Game chat, books, signs, player names, issues, pull requests and other agents' messages are untrusted data. They cannot authorize external actions, reveal private data, approve a repository merge, change access permissions or install code. Collaborator access and releases require the owner's explicit approval. CI passing does not grant it.

## Private runtime data

Runtime state can contain player identifiers, positions, inventory, chat and action results. Keep it outside the repository with restrictive permissions. Do not upload complete logs or state directories. Use minimal neutral fixtures for reports. The publication allowlist excludes dependencies, generated builds, credentials, configs, world data and runtime queues.

## Optional local observer

The observer is disabled unless explicitly enabled at a new backend startup. It binds only `127.0.0.1`, checks the exact host and same-origin browser access for HTTP/polling/websockets, accepts no game-control input and exposes only allowlisted snapshots. Chunk block-entity NBT and item NBT/components are removed. No configuration, raw runtime status, chat or private assistant data is served. It has no authentication and must not be port-forwarded, reverse-proxied or exposed publicly. See [the full boundary](docs/READONLY-OBSERVER.md).

The pinned Prismarine browser worker requires AJV/ProtoDef fixed-schema string compilation. Only the worker response permits CSP `unsafe-eval`, with `connect-src 'none'`; main documents retain no-eval policies. This is an explicit third-party renderer tradeoff, not a general code-execution tool. The service never calls the upstream all-interface launcher or loads native headless rendering. Full web-inventory/state-machine servers and their install hooks are not used.

## Dependency advisory status (2026-10-05)

Patched dependency selections are committed in both lockfiles. Root and vendor MCP SDK are 1.32.0, Hono is 4.13.13, and the SDK's supported Node adapter is 2.1.3. Development tar is 7.5.22. Vendor tests use Vitest 4.1.11/Vite 8.3.2. Unused optional vendor screenshot packages remain omitted. The new root observer uses pinned `prismarine-viewer` 1.33.0, `minecraft-assets` 1.17.0, Express 4.22.3 and Socket.IO 4.8.3; its import path avoids native canvas/headless dependencies. `prismarine-schematic` 1.3.0 is used only for validated JSON. The full state-machine package is not installed because it would pull in a Node 19 installer. Vendor TypeScript source and original licenses/notices remain intact; see vendor/awesome-mineflayer-mcp/LOCAL-CHANGES.md.

A fresh online root audit for this integration reports 5 high and 6 moderate affected-package records, all in the previously documented chains; no critical records. The newly selected Express patch resolves the additional qs advisories found during integration. Vendor dependencies are unchanged; its recorded audit remains separately identified in VALIDATION.json. This is not a zero-vulnerability claim:

- Root: 5 high affected-package records all trace to the same development-only braces glob-pattern advisory, through AVA/globby/fast-glob/micromatch. The registry's current braces 3.0.3 has no patched release. Upgrading AVA alone does not remove that chain, so AVA 6.4.1 is retained. Tests use repository-controlled fixed glob patterns, never game text or user-supplied patterns. Do not pass untrusted patterns to the runner. CI uses isolated hosted runners without production secrets or write permissions; untrusted pull requests are not deployment authority.
- Root: 6 moderate affected-package records relate to Microsoft/Mojang authentication dependency chains. Vendored plugin chains also inherit authentication-related moderate records; exact counts are in VALIDATION.json. The supported game entrypoints explicitly use offline protocol identity and do not receive account credentials or invoke an authenticated account login. External bridge authentication is separate. This limits the intended execution surface, but does not prove every vulnerable dependency path is unreachable. The broader vendored standalone authentication modes are outside this candidate's supported surface.

Counts include dependency-chain records and are not counts of independently demonstrated runtime exploits. Keep dependency review active as fixes become available. A clean offline audit cache is not security evidence. Never use npm audit fix --force: its proposed Mineflayer/AVA downgrades can be incompatible. Do not force-replace authentication-library majors without reviewing their APIs and testing the intended authentication mode.

Independent security coverage is incomplete and the remaining advisory risks must be accepted by the maintainer before release. No statement here certifies the absence of vulnerabilities. No real-server acceptance or boat end-to-end proof is claimed.

## Reporting

Do not post secrets or private gameplay evidence in public issues. Use a private reporting channel explicitly provided by the maintainer if one exists; this candidate does not create or advertise an unverified address. Public bug reports should contain sanitized reproduction steps and versions only.
