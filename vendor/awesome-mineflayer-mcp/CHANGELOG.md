# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [1.3.2]

### Fixed

- **MCP Registry namespace casing.** The registry authorizes the GitHub login
  with its exact casing (`io.github.G0Osey99/*`), not lowercased. Corrected the
  server name / `mcpName` / Dockerfile label to `io.github.G0Osey99/awesome-mineflayer-mcp`.
  (The GHCR image path stays lowercase, as GHCR requires.)

## [1.3.1]

### Fixed

- **Docker image build** (GHCR publish) — the runtime stage ran the `prepare`
  build script under `--omit=dev`, so `tsc` was missing (exit 127). Build stages
  now use `--ignore-scripts` and a Node 22 base image.
- **MCP Registry publish** — shortened `server.json` `description` to the
  registry's 100-character limit.

(The npm package was published correctly at 1.3.0; this patch only fixes the
Docker and MCP-registry release steps.)

## [1.3.0]

### Added

- **Vision** — two ways to let the agent *see*:
  - **`get_screenshot`** captures a REAL textured Minecraft render (first-person
    from the bot's eyes, or third-person) — an actual in-game screenshot, not a
    schematic. Renders the live world via `prismarine-viewer` and screenshots it
    with a headless browser (Playwright driving system Chrome/Edge — no native
    build). The renderer deps are **optional** (lazy-loaded); without them the
    tool returns a clear `UNSUPPORTED` and the rest of the server is unaffected.
  - **`render_map`** renders a colored top-down map (or `mode:"slice"`
    cross-section) using a dependency-free PNG encoder (built-in `zlib` only) —
    a lightweight schematic/minimap that works everywhere with no extra deps.
- **Build/dig macros** `[build]` — `clear_region`, `dig_tunnel`, `dig_staircase`,
  `fill_region`: cancellable, tool-aware loops over many blocks with progress
  reporting, instead of one-block-per-call.
- **Persistent waypoints** `[waypoints]` — `set_waypoint`, `list_waypoints`,
  `delete_waypoint`, `goto_waypoint`, persisted under the config home so spatial
  memory survives restarts. Plus a `bot://waypoints` resource.
- **Resource templates** — `block://{x}/{y}/{z}` and `entity://{id}` for
  on-demand, @-mentionable lookups.
- **Advanced raw protocol group** `[raw]` (off by default; enable with
  `MCP_ENABLE_RAW`) — `send_packet`, `subscribe_packet`, `list_packet_subscriptions`.
- **Library entry point** — `import { buildServer, BotManager, … } from "awesome-mineflayer-mcp"`
  (package `exports`/`types`; the CLI bin is unchanged).
- **Tooling** — ESLint + Prettier configs and `lint`/`format` scripts; a
  generated `docs/TOOLS.md` (`npm run docs:tools`) with a drift check; and a
  gated integration test suite (`npm run test:integration`) against the
  docker-compose server.

## [1.2.0]

### ⚠️ Breaking

- **`run_command` now enforces a command policy.** Server-administration verbs
  (`op`, `deop`, `ban`, `ban-ip`, `pardon`, `kick`, `stop`, `whitelist`,
  `save-*`, `reload`, `debug`, `datapack`, `forceload`, and the
  `execute`/`function`/`schedule` wrappers) are **blocked by default** and return
  a `FORBIDDEN` error. Ordinary gameplay commands (`/tp`, `/time`, `/give`,
  `/gamemode`, …) are unaffected. If your agent relied on running admin commands,
  set `MCP_COMMAND_DENY=""` to allow everything, or `MCP_COMMAND_DENY=<your list>`
  to customize. The policy is best-effort defense-in-depth — see the README's
  Safety section.

### Added

- **MCP Prompts** — guided, parameterized workflows (`getting_started`,
  `gather_wood`, `mine_to_diamonds`, `build_shelter`, `find_and_smelt`,
  `follow_and_defend`) with block/item-name autocompletion. The server now
  advertises the `prompts` (and, via completable args, `completions`) capability.
- **`get_observation` tool** — one-call situational snapshot (status, self,
  inventory, nearby entities, new events) for an agent's observe loop.
- **`structuredContent`** on every tool result (in addition to the text block),
  bounded by `CHARACTER_LIMIT`.
- **Safety guardrails** (all env-configurable): `MCP_READ_ONLY` (observe-only
  mode), `MCP_COMMAND_DENY` / `MCP_COMMAND_ALLOW` (command policy),
  `MCP_ALLOWED_HOSTS` (connect host allow-list), `MCP_CHAT_MIN_INTERVAL_MS`
  (outbound send throttle). Passwords/tokens are redacted from error messages.
- **Actionable connection errors** — login failures map to specific codes
  (`CONNECT_REFUSED`, `VERSION_MISMATCH`, `ONLINE_MODE`, `AUTH_FAILED`, …) with
  remediation suggestions, instead of an opaque `INTERNAL`.
- **Distribution & docs** — `Dockerfile`, `docker-compose.yml` (throwaway local
  test server), `smithery.yaml`, `server.json` (MCP registry), `CONTRIBUTING.md`,
  `NOTICE` (third-party attribution), a README troubleshooting table, a "get a
  server in 2 minutes" quickstart, and a supported-versions note.
- Safety timeouts on the window round-trip tools (open/deposit/withdraw/furnace/
  villager/enchant/anvil) and on `craft_item`.

### Fixed

- **`get_events` no longer silently drops events** when `limit` is exceeded — it
  now forward-paginates (returns the oldest unread and advances `nextSince` to
  the last returned), so the remainder is delivered on the next call.
- **Manual disconnect during an in-flight auto-reconnect** is now honoured
  instead of being silently overridden, and no longer leaves the status stuck at
  `reconnecting`.
- Added process-level `unhandledRejection` / `uncaughtException` guards so a
  stray fire-and-forget rejection can't take down the server.
- `craft_item` (and the window tools) can no longer hang the action lock
  indefinitely on a stalled server round-trip.

## [1.1.0]

- Default-account autonomous startup, `setup` wizard, `connect_default` /
  `get_default_account` tools, and `MCP_DEFAULT_*` env configuration.

## [1.0.0]

- Initial release: 100+ tools across 23 groups, 5 subscribe-capable resources,
  dual (poll + push) event streaming, name resolution, typed errors.
