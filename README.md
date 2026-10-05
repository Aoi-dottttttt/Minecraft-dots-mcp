# Minecraft dots MCP: shared guarded runtime

A shared maintenance project: fix a bug once, keep a neutral regression, and share reviewed improvements across installations. Each installation keeps its own configuration, credentials and game state local. Contributions use [forks and pull requests](CONTRIBUTING.md); installation and gameplay still need the respective user’s authorization.

Public source candidate **3.2.0-rc.1**, based on 3.1.0-dot.2 for Minecraft Java **1.21.1 / protocol 767**. It combines server-authoritative inventory/crafting checks with a persistent game backend and a restartable MCP controller. [中文快速开始](README.zh-CN.md)

This is experimental software. A registered tool is not proof that its complete behavior works on a real server. In particular, **boat placement/riding is not live-validated and is not advertised as working**. Back up valuable worlds, use an authorized test environment first, and review [scope and limits](INTEGRATION.md) and [security](SECURITY.md). The dependency audit still requires reviewing documented development-only glob and optional authentication-chain advisories; this candidate is not a blanket security certification.

## Requirements

- Node.js 22.13+ or 24+ and npm; Linux is required for the persistent Unix-socket runtime
- Python 3 for the file-queue helper; Tk and Linux pidfd support for the optional native launcher
- An MCP client that supports local stdio processes
- Permission to connect a bot to the chosen Minecraft server and change that world

The guarded runtime connects only to loopback using Minecraft's `offline` protocol identity. This does **not** authenticate a Microsoft account or bypass a whitelist, server login plugin, ownership rule, or server policy. For a remote/authenticated server, provide your own separately authorized local bridge or supported authentication integration. No bridge, account, password, token, real server configuration, or server deployment system is included.

## Install and offline checks

From the repository root:

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix vendor/awesome-mineflayer-mcp
npm run build:upstream
npm run verify
npm run test:upstream
```

Both lockfiles are included. `verify` builds first-party code and runs type, lint, unit, stdio, synthetic protocol, queue, launcher lifecycle and daemon checks. Tests use fake fixtures and loopback, never an existing server or account. Loopback/Unix-socket tests need an environment that permits local sockets. See [VALIDATION.json](VALIDATION.json) for the checks actually completed for this candidate.

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

Alternatively, a file-queue controller can attach to the same daemon:

```sh
CONTROLLER_DIR="$(mktemp -d)"
node runtime/minecraft-client.mjs --attach "$GAME_DIR" --state-dir "$CONTROLLER_DIR"
# From another terminal, using that same controller directory:
python3 runtime/call.py --state-dir "$CONTROLLER_DIR" get-session-status
```

Only one controller may act at a time. Stop the first controller before attaching a replacement. Never reuse a previous controller queue or retry an uncertain item operation. Use `disconnect-player` to end the game explicitly. Controller detach stops continuous control but preserves the daemon; the bot can still be harmed while unattended. A real disconnect never triggers automatic reconnect.

The optional Linux Start window is documented in [PERSISTENT-SESSIONS.md](PERSISTENT-SESSIONS.md). It requires an external user-supplied bridge and does not read its configuration until Start is clicked.

## Optional read-only observation

Add `--observe-port 3100` only when starting a new authorized daemon session to serve a local status/inventory dashboard and Prismarine 3D reconstruction at `http://127.0.0.1:3100/`. It shares the existing bot, accepts no gameplay actions and is disabled by default. No remote bind, authentication or public exposure is added. See [observer architecture, security and tests](docs/READONLY-OBSERVER.md).

## Entrypoints and safety scope

- `runtime/minecraft-daemon.mjs` + `minecraft-frontend.mjs`: guarded integrated runtime
- `runtime/minecraft-client.mjs`: private file-queue controller for that runtime
- `dist/main.js`: legacy compatibility entry, disconnected by default; its smaller tool surface does **not** apply all guarded-runtime policies (including the guarded chat/command restrictions)
- `vendor/awesome-mineflayer-mcp`: reusable upstream tool source; its standalone entrypoints are **not** the guarded runtime and can expose broader features

Do not expose any of these as an unauthenticated remote service. All gameplay changes still require the user's authorization. Incoming game text, names, books and signs are untrusted data.

## Provenance and licenses

- Yuniko Software's `minecraft-mcp-server` 2.0.4, source commit `240c8cec337ce152cc9e058ebdef511055808406`: Apache-2.0, retained in [LICENSE](LICENSE) and [NOTICE](NOTICE)
- `awesome-mineflayer-mcp` 1.3.2, commit `89a407ca18a4a39196c6ebe726d5208cff88a9e5`: MIT, retained in [vendor LICENSE](vendor/awesome-mineflayer-mcp/LICENSE) and [vendor NOTICE](vendor/awesome-mineflayer-mcp/NOTICE)
- First-party modifications and verification scope: [RELEASE.md](RELEASE.md)

The initial public tree intentionally contains no private Git history. Dependency packages retain their own licenses when installed. Minecraft is a trademark of Mojang; this project is not affiliated with Mojang or Microsoft.
