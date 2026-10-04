# awesome-mineflayer-mcp

[![npm version](https://img.shields.io/npm/v/awesome-mineflayer-mcp.svg)](https://www.npmjs.com/package/awesome-mineflayer-mcp)
[![node](https://img.shields.io/node/v/awesome-mineflayer-mcp.svg)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A production-ready [Model Context Protocol](https://modelcontextprotocol.io) server that gives an LLM agent **standalone-equivalent control** over a [Mineflayer](https://github.com/PrismarineJS/mineflayer) Minecraft bot — movement, mining, crafting, inventory, combat, containers, chat, and much more — exposed as **123 strongly-typed tools** across 26 groups, plus **guided prompts**, **vision** (real first-person screenshots + schematic maps), persistent **waypoints**, build/dig **macros**, and dual (poll + push) event streaming, with full bot lifecycle management. Tool results carry both human-readable text and machine-readable `structuredContent`.

Backed by the Mineflayer ecosystem: `mineflayer-pathfinder` (A\* navigation), `mineflayer-pvp` (combat), `mineflayer-collectblock` (gathering), `mineflayer-tool` (auto tool-select), `mineflayer-auto-eat`, and `mineflayer-armor-manager`.

---

## Requirements

- **Node.js ≥ 20** (developed on 22.16)
- A Minecraft server to connect to (Java Edition). The bot auto-detects the server version. Don't have one? See [Get a server to test against](#get-a-minecraft-server-to-test-against).
- For online-mode servers: a Microsoft account (`auth: "microsoft"`).

### Supported versions

| | Supported |
|---|---|
| Minecraft (Java) | the range supported by the bundled `mineflayer` 4.37 / `minecraft-data` (roughly **1.8 → 1.21.x**); version is auto-detected, or pass `version` explicitly |
| Node.js | **20, 22** (LTS) |

A few tools only work on newer versions/features (e.g. `elytra_fly`, chat signing). On a version mismatch the bot is kicked with an `outdated client/server` message — pass an explicit `version`.

## Installation

Run it on demand with **npx** (no install needed):

```bash
npx awesome-mineflayer-mcp
```

…or install it globally:

```bash
npm install -g awesome-mineflayer-mcp
awesome-mineflayer-mcp
```

The server speaks MCP over **stdio**, so it is normally launched by your MCP client rather than run by hand.

## Use with an MCP client

Add it to your client's MCP server configuration. The recommended form uses `npx` so you always get the latest published build:

**Claude Desktop** (`claude_desktop_config.json`), **Claude Code**, **Cursor**, or any stdio MCP client:

```json
{
  "mcpServers": {
    "mineflayer": {
      "command": "npx",
      "args": ["-y", "awesome-mineflayer-mcp"],
      "env": {
        "MCP_DISABLE_GROUPS": ""
      }
    }
  }
}
```

If you installed it globally, use `"command": "awesome-mineflayer-mcp"` with `"args": []` instead.

## Get a Minecraft server to test against

If you don't already have a server, spin up a throwaway **offline-mode** one with Docker (no account needed):

```bash
# from a clone of this repo:
docker compose up -d        # offline 1.20.4 server on localhost:25565
docker compose logs -f      # wait for "Done (…)! For help, type "help""
```

…or a one-liner without the repo:

```bash
docker run -d --name mc -p 25565:25565 -e EULA=TRUE -e ONLINE_MODE=FALSE -e VERSION=1.20.4 itzg/minecraft-server
```

Then connect: `connect_bot { host: "localhost", username: "DevBot", auth: "offline" }`. Tear it down with `docker compose down -v` (or `docker rm -f mc`). Don't expose an offline-mode server to the public internet.

## Autonomous operation (default account)

For hands-off use, configure a **default account** so the bot connects automatically on startup — no `connect_bot` call required. Run the interactive setup:

```bash
npx awesome-mineflayer-mcp setup
```

It asks for the server host/port, an **offline** or **Microsoft** account, and whether to auto-connect on startup, then writes `~/.awesome-mineflayer-mcp/config.json` (**no password is stored**). For a Microsoft account it runs the device-code sign-in **once** and caches the token under `profilesFolder`, so later startups need no prompt.

On startup the server auto-connects the configured account (verify with `get_connection_status`). The agent can also call **`connect_default`** to (re)connect it or **`get_default_account`** to inspect it.

### Configure without the wizard (env vars)

You can set the default account entirely from your MCP client config — handy for headless deploys. Environment variables override the config file:

```json
{
  "mcpServers": {
    "mineflayer": {
      "command": "npx",
      "args": ["-y", "awesome-mineflayer-mcp"],
      "env": {
        "MCP_DEFAULT_HOST": "play.example.net",
        "MCP_DEFAULT_USERNAME": "MyBot",
        "MCP_DEFAULT_AUTH": "offline",
        "MCP_AUTO_CONNECT": "true"
      }
    }
  }
}
```

For Microsoft auth in a headless setup, run `setup` once locally first (or point `MCP_PROFILES_FOLDER` at a directory with a pre-cached token).

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `MCP_DISABLE_GROUPS` | _(none)_ | Comma-separated tool-group keys to disable (see catalog). Trim the surface for clients that struggle with a large tool list. |
| `MCP_CHARACTER_LIMIT` | `25000` | Max characters returned by any single tool call (truncated with a marker). |
| `MCP_EVENT_BUFFER` | `1000` | Size of the in-memory event ring buffer. |
| `MCP_THROTTLE_MS` | `250` | Minimum spacing between pushed resource-update / log notifications. |
| `MCP_PROXIMITY_RADIUS` | `32` | Radius (blocks) for proximity-filtered events (entity spawns, sounds). |
| `MCP_ACTION_TIMEOUT_MS` | `60000` | Default timeout for long actions when the caller omits one. |
| `MCP_DEFAULT_HOST` / `MCP_DEFAULT_PORT` | — | Default server to auto-connect on startup. |
| `MCP_DEFAULT_USERNAME` | — | Default account name (offline) or email (microsoft). |
| `MCP_DEFAULT_AUTH` | `offline` | Default auth mode: `offline` or `microsoft`. |
| `MCP_DEFAULT_VERSION` | auto | Force a protocol version for the default account. |
| `MCP_DEFAULT_AUTO_RECONNECT` | `true` | Auto-reconnect the default account on disconnect. |
| `MCP_AUTO_CONNECT` | `true`† | Auto-connect the default on startup († when a default is configured). |
| `MCP_PROFILES_FOLDER` | `<home>/profiles` | Microsoft auth token-cache directory. |
| `AWESOME_MINEFLAYER_MCP_HOME` | `~/.awesome-mineflayer-mcp` | Config + token-cache directory. |
| `MCP_READ_ONLY` | `false` | Observe-only mode: register only read-only tools (+ lifecycle). See [Safety](#safety--guardrails). |
| `MCP_COMMAND_DENY` | _(admin verbs)_ | Slash commands `run_command` blocks. Setting it **replaces** the default; set empty to allow all. |
| `MCP_COMMAND_ALLOW` | _(none)_ | If set, a strict allow-list: only these commands run (deny list ignored). |
| `MCP_ALLOWED_HOSTS` | _(any)_ | Comma-separated allow-list of hosts the bot may connect to. |
| `MCP_CHAT_MIN_INTERVAL_MS` | `0` | Minimum spacing between outbound chat/whisper/command sends (anti-spam). |
| `MCP_ENABLE_RAW` | `false` | Enable the advanced/unsafe `raw` protocol tool group (direct packet send/subscribe). |
| `MCP_SCREENSHOT_WIDTH` / `_HEIGHT` | `800` / `450` | Default `get_screenshot` image size (px). |
| `MCP_SCREENSHOT_LOAD_MS` | `2500` | How long to let the world render before capturing a screenshot. |
| `MCP_VIEW_DISTANCE` | `4` | Chunk render distance for screenshots. |
| `MCP_SCREENSHOT_BROWSER_CHANNEL` | _(auto)_ | Browser channel for screenshots (`chrome`, `msedge`, `chromium`). |
| `MCP_SCREENSHOT_EXECUTABLE_PATH` | _(none)_ | Explicit browser executable path for screenshots (overrides channel). |

Example — disable rarely-used groups:

```
MCP_DISABLE_GROUPS=creative,villager,enchanting,settings
```

## Quick start (tool flow)

1. **`connect_bot`** `{ host, username, auth }` — connect (resolves once the bot spawns). *Skip this if you configured a [default account](#autonomous-operation-default-account) — the bot auto-connects on startup; just check `get_connection_status`.*
2. Act: **`goto`**, **`dig`**, **`collect_block`**, **`craft_item`**, **`pvp_attack`**, **`chat`**, …
3. Observe: call **`get_observation`** for a one-shot snapshot (vitals, position, inventory, nearby entities, new events) — pass the returned `events.nextSince` back each tick. Or compose **`get_state`** / **`get_inventory`** / **`list_entities`** / **`get_events`**, or subscribe to the `bot://*` resources.
4. **`disconnect_bot`** when done.

New to the server? Use the **`getting_started`** prompt (see [Prompts](#prompts)) for an in-context walkthrough.

Block / item / entity arguments accept **human names** (`"iron_ore"`, `"diamond_pickaxe"`, `"zombie"`); unknown names return fuzzy suggestions.

## Authentication

- `auth: "offline"` (default) — offline-mode servers; `username` is the in-game name.
- `auth: "microsoft"` — `username` is the account email. A device-code prompt is emitted as an `msa_code` event / log notification. Set **`profilesFolder`** to cache the token so subsequent runs skip the prompt, or pass a cached `accessToken`. **Tip:** run `npx awesome-mineflayer-mcp setup` once to do the device-code sign-in and cache the token, then the server connects autonomously (see [Autonomous operation](#autonomous-operation-default-account)).

---

## Tool catalog (123 tools, 26 groups)

> Full generated reference (every tool, prompt, resource): [`docs/TOOLS.md`](docs/TOOLS.md).

Group keys (for `MCP_DISABLE_GROUPS`) are shown in brackets.

- **Lifecycle** `[lifecycle]` — `connect_bot`, `connect_default`, `disconnect_bot`, `reconnect_bot`, `respawn`, `get_connection_status`, `get_default_account`
- **State & inspection** `[state]` (read-only) — `get_observation` (one-call snapshot for an agent's observe loop), `get_state`, `get_inventory`, `list_players`, `list_entities`, `find_nearest_entity`, `get_entity_details`, `get_scoreboards`, `get_teams`, `get_boss_bars`, `get_control_states`, `get_chat_patterns`, `support_feature`, `pathfinder_status`, `get_settings`, `get_physics`, `get_loaded_plugins`
- **World queries** `[world]` (read-only) — `get_block_at`, `find_blocks`, `get_cursor_target`, `get_blocks_in_region`, `wait_for_chunks_to_load`
- **Movement & pathfinding** `[movement]` — `goto`, `set_goal`, `flee_from`, `follow_entity`, `stop_pathfinding`, `get_path_to`, `configure_movements`, `configure_pathfinder`, `set_control_state`, `clear_control_states`, `elytra_fly`, `wait_for_ticks`, `set_physics_enabled`
- **Look** `[look]` — `look_at`, `look`, `look_at_entity`
- **Digging & building** `[digging]` — `dig`, `place_block`, `activate_block`, `activate_entity`, `swing_arm`
- **Combat** `[combat]` — `pvp_attack`, `attack_entity`, `pvp_stop`, `pvp_configure`
- **Inventory & items** `[inventory]` — `equip_item`, `unequip_item`, `toss_item`, `set_quickbar_slot`, `consume`, `activate_item`, `click_window`, `move_slot_item`, `transfer_items`
- **Containers** `[containers]` — `open_container`, `read_open_container`, `container_deposit`, `container_withdraw`, `close_window`
- **Furnace / smelting** `[furnace]` — `open_furnace`, `furnace_action`, `furnace_status`, `smelt_item`
- **Enchanting & anvil** `[enchanting]` — `enchant_item`, `anvil_combine`
- **Villager trading** `[villager]` — `open_villager`, `trade_with_villager`
- **Crafting** `[crafting]` — `list_recipes`, `craft_item`
- **Block gathering** `[gathering]` — `collect_block`, `cancel_collect`, `set_collect_config`
- **Tool auto-select** `[tool]` — `equip_tool_for_block`, `set_tool_chest_locations`, `get_best_tool`
- **Survival automation** `[survival]` — `autoeat_set_enabled`, `autoeat_configure`, `autoeat_eat`, `autoeat_cancel`, `autoeat_preview`, `armor_equip_all`
- **Beds & sleep** `[beds]` — `sleep`, `wake`
- **Vehicles** `[vehicles]` — `mount_entity`, `dismount`, `steer_vehicle`
- **Fishing, books & signs** `[fishing]` — `fish`, `cancel_fish`, `write_book`, `update_sign`
- **Chat & communication** `[chat]` — `chat`, `whisper`, `run_command`, `tab_complete`, `register_chat_pattern`, `remove_chat_pattern`, `wait_for_message`
- **Settings** `[settings]` — `set_settings`
- **Creative mode** `[creative]` — `creative_set_inventory_slot`, `creative_clear_inventory`, `creative_fly`, `creative_fly_to`
- **Vision** `[vision]` — `get_screenshot` (real first-person textured game render), `render_map` (dependency-free schematic map) — see [Vision](#vision--let-the-agent-see)
- **Waypoints** `[waypoints]` — `set_waypoint`, `list_waypoints`, `delete_waypoint`, `goto_waypoint` (persisted across restarts)
- **Build & dig macros** `[build]` — `clear_region`, `dig_tunnel`, `dig_staircase`, `fill_region` (cancellable, multi-block)
- **Events & telemetry** `[events]` — `get_events`, `cancel_task`
- **Raw protocol** `[raw]` — `send_packet`, `subscribe_packet`, `list_packet_subscriptions` (advanced/unsafe; **off unless `MCP_ENABLE_RAW=true`**)

Long-running actions (`goto`, `dig`, `collect_block`, `pvp_attack`, `fish`, `smelt_item`, `craft_item`) are mutually exclusive and cancellable — start a new movement/combat action to supersede the prior one, or call `stop_pathfinding` / `pvp_stop` / `cancel_collect` / `cancel_fish` / `cancel_task`.

## Prompts

The server exposes **guided, parameterized workflows** as MCP prompts — clients surface them as slash-commands / templates. They teach an agent how to chain the right tools for a goal:

- **`getting_started`** — orientation: connect → observe → act → recover.
- **`gather_wood`** `{ count?, logType? }` — find trees and collect logs.
- **`mine_to_diamonds`** `{ targetY? }` — descend safely and branch-mine.
- **`build_shelter`** `{ material? }` — enclose a safe space before nightfall.
- **`find_and_smelt`** `{ input, fuel? }` — mine/gather an input and smelt it.
- **`follow_and_defend`** `{ player }` — follow a player and fight off hostiles.

Block/item arguments offer name autocompletion drawn from the connected world.

## Vision — let the agent *see*

Two complementary tools return PNG images as MCP image content, so a vision-capable model (and a human) can look at the world instead of reconstructing it from JSON.

### `get_screenshot` — a real game render

Captures an **actual textured Minecraft render** of what the bot sees — first-person from its eyes (default) or a third-person orbit — exactly like an in-game screenshot. Under the hood, [`prismarine-viewer`](https://github.com/PrismarineJS/prismarine-viewer) renders the real world (client-side WebGL) and a headless browser screenshots it. Args: `width`, `height`, `firstPerson`, `waitMs`, `viewDistance`.

**Setup (one-time).** The renderer deps ship as **optional** packages (installed by default with `npm install`). All you also need is a browser:

- Already have **Google Chrome or Microsoft Edge**? Nothing to do — it's used automatically.
- Otherwise run **`npx playwright install chromium`** once.
- Headless servers: install Chrome/Chromium, or set `MCP_SCREENSHOT_EXECUTABLE_PATH` / `MCP_SCREENSHOT_BROWSER_CHANNEL`.

If the deps/browser aren't available, `get_screenshot` returns a clear `UNSUPPORTED` error with these steps — the rest of the server is unaffected. The renderer packages are pure-JS (no native build), but if you want the leanest possible install and don't need screenshots, use `npm install --omit=optional`.

### `render_map` — a dependency-free schematic

A lightweight colored top-down map (or `mode:"slice"` cross-section) drawn from block data with a **built-in PNG encoder** (no extra deps at all). Good as a minimap/overview or when the screenshot extras aren't installed. North (−Z) is up; bot = white dot with a facing tick; players cyan, hostiles red, passives yellow, items grey; includes a block legend.

## Safety & guardrails

Sensible defaults that matter once an agent drives the bot autonomously (especially with a [default account](#autonomous-operation-default-account)):

- **Command policy.** `run_command` blocks server-administration verbs by default (`op`, `deop`, `ban`, `kick`, `stop`, `whitelist`, and the `execute`/`function`/`schedule` wrappers, …). Ordinary gameplay commands (`/tp`, `/time`, `/give`, …) are allowed. Override with `MCP_COMMAND_DENY` (replaces the default; empty = allow all) or lock down with `MCP_COMMAND_ALLOW` (strict allow-list). This is **best-effort defense-in-depth**, not a hard boundary — it gates on the first command verb, and a bot with operator permissions could still find a way around it. For untrusted/autonomous deployments, prefer `MCP_COMMAND_ALLOW`, `MCP_READ_ONLY`, and not granting the bot's account operator rights. **Note:** incoming player chat is delivered to your agent as events — treat it as untrusted input.
- **Host allow-list.** `MCP_ALLOWED_HOSTS` restricts which servers `connect_bot` / `reconnect_bot` may join, so an agent can't repoint the bot (and its cached token) at an arbitrary address.
- **Read-only mode.** `MCP_READ_ONLY=true` registers only observation tools (plus connection management) — look-but-don't-touch.
- **Rate limiting.** `MCP_CHAT_MIN_INTERVAL_MS` spaces outbound chat/commands to avoid spam-kicks.
- **No secret leakage.** Passwords / access tokens are never stored on disk and are redacted from connection-error messages.

## Resources

Subscribe-capable JSON resources for clients that support resource subscriptions:

- `bot://state` — live self snapshot (position, vitals, gamemode, time, weather, held item, control states)
- `bot://inventory` — items, armor, off-hand, held slot
- `world://entities` — up to 50 nearest tracked entities
- `world://players` — server roster
- `bot://events` — tail of recent events
- `bot://waypoints` — saved named waypoints

Plus parameterized **resource templates** for on-demand lookups: `block://{x}/{y}/{z}` and `entity://{id}`.

## Events

Game events are delivered two ways:

- **Pull:** `get_events({ since, types, limit })` drains a ring buffer; pass the returned `nextSince` to read only new events. `dropped: true` signals the buffer overflowed since your `since`.
- **Push:** subscribed resources emit throttled `notifications/resources/updated`; notable lines (chat, death, kick, error, msa_code) are forwarded via `sendLoggingMessage`.

High-frequency observations (movement, per-tick updates, block/entity updates, time) are intentionally **not** buffered — read them on demand via `get_state` and the read-only tools.

## Development (from source)

```bash
git clone https://github.com/G0Osey99/awesome-mineflayer-mcp.git
cd awesome-mineflayer-mcp
npm install
npm run build       # tsc -> dist/
npm run typecheck   # tsc --noEmit
npm test            # vitest (unit tests for the pure logic)
npm run dev         # tsx src/index.ts (run from source, no build step)
```

Architecture and the full design rationale: [`docs/superpowers/specs/2026-06-28-mineflayer-mcp-server-design.md`](docs/superpowers/specs/2026-06-28-mineflayer-mcp-server-design.md).

```
src/
  index.ts        entry (stdio transport, graceful shutdown, crash guards)
  server.ts       builds the McpServer, registers tool groups + resources + prompts
  config.ts       env + constants + safety policy (groups, read-only, command/host allow-lists)
  bot/            manager (lifecycle FSM), plugins, events, wire-events, state, windows, action-locks
  tools/          one module per tool group (+ registry.ts)
  prompts/        guided multi-tool workflows
  resources/      MCP resources + push notifications
  util/           errors, format, result, resolve (name→id + fuzzy), serialize, async, redact
  schemas/        shared Zod fragments
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to add a tool/group and run a local test server.

## Publishing (maintainers)

Pushing a `v*` tag publishes to **npm**, **GitHub Container Registry** (Docker), the **MCP Registry**, and updates **Smithery** — all via [`.github/workflows/ci.yml`](.github/workflows/ci.yml). `npm version` keeps `package.json`, `src/config.ts`, and `server.json` in sync.

```bash
npm version minor        # bumps + syncs versions, commits, and tags
git push --follow-tags   # triggers the release jobs
```

Full one-time setup and the step-by-step release checklist are in [`RELEASE.md`](RELEASE.md). The published npm package ships only `dist/`, `README.md`, `LICENSE`, and `NOTICE` (see the `files` field).

## Troubleshooting

Connection failures now return a **specific error code and suggestions** (not an opaque `INTERNAL`). Common cases:

| Symptom / error | Likely cause | Fix |
|---|---|---|
| `CONNECT_REFUSED` (ECONNREFUSED) | Wrong host/port, or server not running | Check `host`/`port`; confirm the server has finished starting (default port 25565). |
| `CONNECT_REFUSED` (ENOTFOUND) | Hostname doesn't resolve | Double-check the server address. |
| `ONLINE_MODE` / "unverified username" | Server is online-mode; bot used offline auth | Use `auth: "microsoft"`, or set `online-mode=false` on the server. |
| `VERSION_MISMATCH` / "outdated client/server" | Auto-detected version is wrong | Pass an explicit `version` (e.g. `"1.20.4"`). |
| Chat rejected / "secure profile" | Server requires signed chat | Connect with `disableChatSigning: true`. |
| `AUTH_FAILED` | Stale/invalid Microsoft token | Re-run `npx awesome-mineflayer-mcp setup`, or clear the `profilesFolder` cache and sign in again. |
| `FORBIDDEN` on `run_command` | Command blocked by policy | See [Safety](#safety--guardrails) — adjust `MCP_COMMAND_DENY` / `MCP_COMMAND_ALLOW`. |
| `FORBIDDEN` on `connect_bot` | Host not in allow-list | Add it to `MCP_ALLOWED_HOSTS` (or unset to allow any). |
| `NO_PATH` | Pathfinder can't reach the goal | Move closer, clear obstacles, or relax `configure_movements`. |
| Microsoft device-code prompt | First-time MSA sign-in | Visit the URL from the `msa_code` event; set `profilesFolder` to cache it. |

First-run sign-in for Microsoft auth is interactive once — run `npx awesome-mineflayer-mcp setup` to do it and cache the token.

## Docker

A `Dockerfile` is included for headless/autonomous deployments (configure a default account via `MCP_DEFAULT_*`):

```bash
docker build -t awesome-mineflayer-mcp .
```

Mount a volume at `/root/.awesome-mineflayer-mcp` to persist the config and Microsoft token cache. (The server speaks MCP over stdio, so a container is most useful for autonomous default-account runs rather than for a client to spawn.)

## Limitations

- **One bot per server process** (single-session by design).
- **Evaluations require a seeded world.** A live Minecraft world is not deterministic, so the evaluation set in `eval/` targets a documented seeded fixture (see `eval/fixture.md`); it cannot be verified against an arbitrary live server.
- `cancel_fish` is best-effort (Mineflayer exposes no first-class fishing abort).
- Microsoft auth's first run needs an interactive device code (surfaced as an `msa_code` event); use `profilesFolder` to cache it.

## License

MIT
