# Minecraft dots MCP: shared guarded runtime

[简体中文](README.md) | English | [Changelog](CHANGELOG.md)

A shared maintenance project: fix a bug once, keep a neutral regression, and share reviewed improvements across installations. Each installation keeps its own configuration, credentials and game state local. Contributions use [forks and pull requests](CONTRIBUTING.md); installation and gameplay still need the respective user's authorization.

This repository targets Minecraft Java **1.21.1 / protocol 767**. The package/backend version remains **3.2.0-rc.3**, based on 3.1.0-dot.2. Current `main` includes **reactive self-defense V2** and the reviewed **wool/bed dye, placement rotation and partial-block arrival fixes**. These are recorded under Unreleased in the [changelog](CHANGELOG.md); no new release number is implied. Source changes do not upgrade a running game backend. See [compatibility](docs/COMPATIBILITY.md) and [reviewed upgrades](docs/UPGRADING.md).

**This is experimental software.** A registered tool or passing offline fixture is not proof of complete behavior on a real server. In particular, **boat placement/riding/steering and V2 combat effectiveness are not live-validated**. Back up valuable worlds, use an authorized test environment first, and review [scope and limits](INTEGRATION.md) and [security](SECURITY.md). The dependency audit still requires reviewing documented development-only glob and optional authentication-chain advisories; this candidate is not a blanket security certification.

## What the current source includes

- **Persistent session, replaceable controller:** one game backend, one active MCP or file-queue controller, serialized actions, and no automatic reconnect or replay
- **Server-authoritative item operations:** inventory/crafting, exact-stack equipment, containers, consumption and furnace transfers use fresh server evidence; uncertain mutations fence later actions
- **Guarded gameplay tools:** observation, movement/look/pathfinding, mining/placement, block interaction, farming, non-player combat, sleep, fishing, workstation operations, chat, signs/books, events and waypoints have implementations with varying offline coverage. The [capability matrix](docs/CAPABILITY-MATRIX.md) distinguishes dedicated fixtures from catalog-only entries; aliases do not add independent abilities
- **Bounded additions:** dry-route/own-player oxygen guards, explicitly requested surfacing, stepped gather/storage/restock and simple-block blueprint workflows, optional self-defense V2, and default-off read-only observation

Tool availability never grants permission to act. Effect confirmation, server/plugin compatibility and the limitations below still apply.

## Requirements

- Node.js 22.x (at least 22.13) or 24+ and npm; Linux is required for the persistent Unix-socket runtime
- Python 3 for the file-queue helper; Tk and Linux pidfd support for the optional native launcher
- An MCP client that supports local stdio processes
- Permission to connect a bot to the chosen Minecraft server and change that world

The guarded runtime connects only to loopback using Minecraft's `offline` protocol identity. This does **not** authenticate a Microsoft account or bypass a whitelist, server login plugin, ownership rule, or server policy. For a remote/authenticated server, provide your own separately authorized local bridge or supported authentication integration. No bridge, account, password, token, real server configuration, or server deployment system is included. Never put credentials in MCP arguments, chat or command lines.

## Install and offline checks

From the repository root:

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix vendor/awesome-mineflayer-mcp
npm run build:upstream
npm run verify
npm run test:upstream
python3 scripts/publication-manifest.py --check
```

Both lockfiles are included; keep them when installing. `verify` builds first-party code and runs type, lint, unit, stdio, synthetic protocol, queue, launcher lifecycle, daemon, observer, workflow and self-defense checks. Tests use neutral fixtures and loopback, never an existing server or account. Loopback/Unix-socket tests need an environment that permits local sockets.

[GitHub Actions](https://github.com/Aoi-dottttttt/Minecraft-dots-mcp/actions) runs the offline suite on Node 22 and 24, plus separate synthetic browser and native-3D jobs. Check the run for the exact commit being installed. [VALIDATION.json](VALIDATION.json) is the dated rc.3 validation snapshot, including its original local blockers; it is not an up-to-date result for every later commit. Neither CI nor this documentation establishes real-server acceptance.

Networkless inspection:

```sh
node runtime/minecraft-client.mjs --offline-fixture --state-dir "$(mktemp -d)"
```

This runs a fake game backend, writes a local tool catalog and fixture result, then exits. It cannot play Minecraft.

## Start one authorized local game session

Only after approving the server, identity, and intended game actions, start the daemon explicitly. This example uses a local test server or separately started local bridge on port 25565:

```sh
umask 077
GAME_DIR="$(mktemp -d)"
node runtime/minecraft-daemon.mjs --user-started-session 25565 \
  --username ExampleBot --state-dir "$GAME_DIR"
```

Keep that daemon running. Configure your MCP client to execute `node` with arguments `runtime/minecraft-frontend.mjs --attach ABSOLUTE_GAME_DIR` (substitute the actual absolute runtime and game-directory paths in the client configuration). An example is in [examples/mcp-client.example.json](examples/mcp-client.example.json).

Alternatively, a file-queue controller can attach to the same daemon. New terminals do not inherit earlier shell variables: set `GAME_DIR` and `CONTROLLER_DIR` to the corresponding actual directory paths in each new terminal:

```sh
CONTROLLER_DIR="$(mktemp -d)"
node runtime/minecraft-client.mjs --attach "$GAME_DIR" --state-dir "$CONTROLLER_DIR"
# From another terminal, using that same controller directory:
python3 runtime/call.py --state-dir "$CONTROLLER_DIR" get-session-status
```

Only one controller may act at a time. Stop the first controller before attaching a replacement, and use a fresh controller directory. Never reuse a previous controller queue, retry an uncertain item operation, or bypass an uncertainty fence. Use `disconnect-player` to end the game explicitly. Controller detach stops continuous control but preserves the daemon; the bot can still be harmed, fall, drown or be kicked while unattended. A real disconnect never triggers automatic reconnect.

The optional Linux Start window is documented in [PERSISTENT-SESSIONS.md](PERSISTENT-SESSIONS.md). It requires an external user-supplied bridge and does not read its configuration until Start is clicked.

## Latest integrated fixes

Current `main` includes the following reviewed changes from [PR #9](https://github.com/Aoi-dottttttt/Minecraft-dots-mcp/pull/9) and [PR #10](https://github.com/Aoi-dottttttt/Minecraft-dots-mcp/pull/10). Full history is in the [changelog](CHANGELOG.md).

- **Wool and bed dye alternatives:** Java 1.21.1 recipe queries and verified crafting share concrete vanilla color alternatives. Same-color inputs are refused; exact ingredient/output confirmation, cancellation and no-retry rules remain. Other versions and recipe-overriding datapacks/plugins are outside this repair
- **Placement rotation ordering:** native placement aims at the actual clicked face and waits for a native physics tick before rechecking the stable pose, reach, target and held item. A V2 defense request during aiming stops an unsubmitted placement; already-submitted placement settles its critical confirmation first. This does not establish all directional-block, bed or boat placement behavior on real servers
- **Partial-block arrival:** verified movement, including native `goto`, can recognize grounded arrival on supported farmland, bottom slabs and unobstructed lower stair treads using loaded collision geometry. The goal radius, dry/oxygen guards and cancellation remain unchanged; raised/slab doorway thresholds and arbitrary partial-block routes are not thereby enabled
- **Reactive self-defense V2:** renewable passive shielding/facing, bounded level-step requests and a narrowly verified unrelated-armor-wear exception are included. See the preparation and limits below

Detailed evidence and edge cases are in [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md). The package version, IPC version 1 and dependency locks were not changed by these fixes.

## Bounded gameplay additions

[Movement safety](docs/MOVEMENT-SAFETY.md) documents dry-route/own-player oxygen guards, explicit surfacing and boat-launch evidence. Unexpected immersion stops ordinary navigation, but stopping controls does not make a submerged player safe. There is no unattended rescue or automatic shore selection. Surfacing requires a loaded clear source-water column and fresh own-player air evidence; it does not confirm safe dry land. Boat launch/mount/steering still need separately authorized end-to-end live validation.

[Workflows](docs/WORKFLOWS.md) provide reviewable gather → storage → restock plans and simple-block schematic plans. `run-workflow` executes only explicitly requested batches of 1–4 steps with the current `expectedRevision`, keeps exact progress and never resumes/retries uncertain steps. Gather supports a bounded terrain/item set, not general ores, forestry or farm cycles. Blueprints accept bounded `prismarine-schematic` JSON and allowlisted non-directional blocks, not arbitrary binary schematic files, region clearing or a full autonomous survival builder. Reachability and visible-face checks can still refuse a nearby target.

## Optional reactive self-defense V2

[Bounded monster self-defense](docs/SELF-DEFENSE.md) is included in current source, **off by default and explicitly enabled per session**. Prepare a usable hotbar axe/sword and an off-hand shield while safe; armor is not auto-equipped. Use the tools `self-defense-enable`, `self-defense-status` and `self-defense-disable` with `{}`. `stop-movement` also disables defense as an emergency stop.

Only server damage events for this bot trigger a response; retaliation requires an explicitly attributed allowed monster. Players, pets, named entities and uncertain targets are refused. V2 keeps facing an attributed attacker and may renew an eight-second passive-guard lease from fresh damage or a still-visible, valid already-attributed threat. Melee is limited to 12 seconds/16 requests, and movement to at most three guarded same-level step requests within a four-block origin leash. Those active budgets do not renew with the guard lease. No digging, placement, doors, jumps, liquids or blind pursuit is added. Submitted inventory/placement operations retain their confirmation boundary before defense takes the action lane; interrupted work is never automatically replayed.

`shieldRequestActive` reports requested shield use; **`shieldEffectConfirmed` remains false**. Missing/broken shields, cooldown, armor loss, multiple attackers, unknown sources and unavailable escape routes are explicit alerts. V2 does not swap storage equipment during combat. Offline tests do not establish shield timing/effect, live retreat, server/plugin compatibility or survival; do not rely on it for unattended safety. Existing backends require a separately approved installation and new session to load these changes.

## Optional read-only observation

Add `--observe-port 3100` only when starting a new authorized daemon session to serve a local status/inventory dashboard and Prismarine 3D reconstruction at `http://127.0.0.1:3100/`. It shares the existing bot, accepts no gameplay actions and is disabled by default. No remote bind, authentication or public exposure is added. Do not port-forward or reverse-proxy it. See [observer architecture, security and tests](docs/READONLY-OBSERVER.md).

For a native status/inventory window, run `python3 runtime/observer-ui.py --state-dir "$GAME_DIR"` on the same desktop. It reads existing private files only; it does not provide 3D or bypass browser restrictions. Own-player air is based on raw server metadata and unknown values are shown explicitly.

For a file-only native 3D reconstruction, the separate default-off `--observe-world-files` new-session flag exports a 17×13×17 loaded-cell region at most once every two seconds. An explicitly launched mesh worker and separately installed Godot view render official geometry/textures with unknown/stale indicators. See [native startup, limits and resource measurements](docs/WORLD-MESH-PROTOTYPE.md). This is not a native Minecraft client screenshot or an unrestricted world view.

## Entrypoints and safety scope

- `runtime/minecraft-daemon.mjs` + `minecraft-frontend.mjs`: guarded integrated runtime
- `runtime/minecraft-client.mjs`: private file-queue controller for that runtime
- `dist/main.js`: legacy compatibility entry, disconnected by default; its smaller tool surface does **not** apply all guarded-runtime policies (including the guarded chat/command restrictions)
- `vendor/awesome-mineflayer-mcp`: reusable upstream tool source; its standalone entrypoints are **not** the guarded runtime and can expose broader features

Do not expose any of these as an unauthenticated remote service. All gameplay changes still require the user's authorization. Incoming game text, names, books and signs are untrusted data and cannot authorize external actions. Runtime files may contain chat, positions, player identifiers, inventory and action results; keep them private and outside the repository. Never upload complete runtime state or logs.

## Provenance and licenses

- Yuniko Software's `minecraft-mcp-server` 2.0.4, source commit `240c8cec337ce152cc9e058ebdef511055808406`: Apache-2.0, retained in [LICENSE](LICENSE) and [NOTICE](NOTICE)
- `awesome-mineflayer-mcp` 1.3.2, commit `89a407ca18a4a39196c6ebe726d5208cff88a9e5`: MIT, retained in [vendor LICENSE](vendor/awesome-mineflayer-mcp/LICENSE) and [vendor NOTICE](vendor/awesome-mineflayer-mcp/NOTICE)
- First-party modifications and verification scope: [RELEASE.md](RELEASE.md)

The initial public tree intentionally contains no private Git history. Dependency packages retain their own licenses when installed. Minecraft is a trademark of Mojang; this project is not affiliated with Mojang or Microsoft.
