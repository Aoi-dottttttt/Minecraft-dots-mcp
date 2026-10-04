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

## Dependency advisory status (2026-10-04)

Patched dependency selections are committed in both lockfiles. Root and vendor MCP SDK are 1.32.0, Hono is 4.13.13, and the SDK's supported Node adapter is 2.1.3. Development tar is 7.5.22. Vendor tests use Vitest 4.1.11/Vite 8.3.2. Unused optional screenshot/viewer packages are omitted; the guarded catalog already excludes that feature. Vendor TypeScript source and original licenses/notices remain intact; see vendor/awesome-mineflayer-mcp/LOCAL-CHANGES.md.

A fresh online audit after these changes reports zero critical vulnerabilities in either dependency tree. This is not a zero-vulnerability claim:

- Root: 5 high affected-package records all trace to the same development-only braces glob-pattern advisory, through AVA/globby/fast-glob/micromatch. The registry's current braces 3.0.3 has no patched release. Upgrading AVA alone does not remove that chain, so AVA 6.4.1 is retained. Tests use repository-controlled fixed glob patterns, never game text or user-supplied patterns. Do not pass untrusted patterns to the runner. CI uses isolated hosted runners without production secrets or write permissions; untrusted pull requests are not deployment authority.
- Root: 6 moderate affected-package records relate to Microsoft/Mojang authentication dependency chains. Vendored plugin chains also inherit authentication-related moderate records; exact counts are in VALIDATION.json. The supported game entrypoints explicitly use offline protocol identity and do not receive account credentials or invoke an authenticated account login. External bridge authentication is separate. This limits the intended execution surface, but does not prove every vulnerable dependency path is unreachable. The broader vendored standalone authentication modes are outside this candidate's supported surface.

Counts include dependency-chain records and are not counts of independently demonstrated runtime exploits. Keep dependency review active as fixes become available. A clean offline audit cache is not security evidence. Never use npm audit fix --force: its proposed Mineflayer/AVA downgrades can be incompatible. Do not force-replace authentication-library majors without reviewing their APIs and testing the intended authentication mode.

Independent security coverage is incomplete and the remaining advisory risks must be accepted by the maintainer before release. No statement here certifies the absence of vulnerabilities. No real-server acceptance or boat end-to-end proof is claimed.

## Reporting

Do not post secrets or private gameplay evidence in public issues. Use a private reporting channel explicitly provided by the maintainer if one exists; this candidate does not create or advertise an unverified address. Public bug reports should contain sanitized reproduction steps and versions only.
