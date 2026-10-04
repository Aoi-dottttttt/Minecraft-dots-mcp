# Mineflayer MCP Server — Design Spec

**Date:** 2026-06-28
**Status:** Awaiting review → implementation
**Goal:** A production-ready MCP server that gives an LLM agent **standalone-equivalent control** over a Mineflayer bot — everything reachable in the vanilla Mineflayer API plus the pathfinder/pvp/collectblock/tool/auto-eat/armor-manager plugins — exposed as strongly-typed tools, with bot lifecycle management and dual (poll + push) event streaming.

---

## 1. Decisions (locked)

- **Language/runtime:** TypeScript (strict, ESM), Node ≥ 20 (dev on 22.16).
- **MCP SDK:** `@modelcontextprotocol/sdk@^1.29` over **stdio** transport.
  - 1.29 is the latest *published* version. The `main` README documents an unreleased "v2" — **ignore it**. We target 1.29's real API: `server.registerTool(name, {description, inputSchema, annotations}, handler)` where `inputSchema` is a **raw Zod shape** (`{ x: z.number() }`), *not* `z.object(...)`. Handler receives parsed args.
  - 1.29 declares `zod: "^3.25 || ^4.0"`, so we use **Zod 4**.
  - Notifications used: `server.sendLoggingMessage(...)`, `server.sendResourceListChanged()`, and low-level `server.server.notification({ method: "notifications/resources/updated", params: { uri } })` for subscription pushes.
- **Bot model:** **single bot**. No `botId` on tools.
- **Event delivery:** **both** — buffered `get_events` poll + `get_state`/read-only tools, **and** MCP resources with `subscribe: true` + `notifications/resources/updated` + `sendLoggingMessage` for notable lines. All pushes throttled (≤ 1 / ~250 ms).
- **Plugins (all loaded):** `mineflayer-pathfinder@^2.4`, `mineflayer-pvp@^1.3`, `mineflayer-collectblock@^1.6`, `mineflayer-tool@^1.2`, `mineflayer-auto-eat@^5` (pkg id `mineflayer-auto-eat`, attaches `bot.autoEat` = `EatUtil`), `mineflayer-armor-manager@^2`.
- **Tool-group toggles:** every group can be disabled via env (`MCP_DISABLE_GROUPS=creative,villager`); all on by default. Mitigates the large (~85) tool count for clients that degrade with big tool lists.

### Pinned dependency versions (verified 2026-06-28)
| Package | Version |
|---|---|
| mineflayer | 4.37.1 |
| mineflayer-pathfinder | 2.4.5 |
| mineflayer-pvp | 1.3.2 |
| mineflayer-collectblock | 1.6.0 |
| mineflayer-tool | 1.2.0 |
| mineflayer-auto-eat | 5.0.3 |
| mineflayer-armor-manager | 2.0.1 |
| @modelcontextprotocol/sdk | 1.29.0 |
| minecraft-data | 3.111.0 |
| zod | 4.4.3 |
| vec3 | latest |

---

## 2. Architecture

```
src/
  index.ts              entry: build server, connect stdio, graceful shutdown (SIGINT/SIGTERM)
  server.ts             create McpServer, register enabled tool groups + resources
  config.ts             env + constants (CHARACTER_LIMIT=25000, EVENT_BUFFER=1000, THROTTLE_MS=250, disabled groups)
  bot/
    manager.ts          BotManager: single bot + status FSM, connect/disconnect/reconnect, ensureOnline guard, auto-reconnect
    plugins.ts          load + configure all six plugins after createBot
    state.ts            snapshot builders (self/world/inventory/entities/...) -> plain JSON
    events.ts           EventBus: ring buffer (seq/ts/type/data), event wiring, classification, throttled push
    windows.ts          open-window session tracking (one active window; serialize contents)
    action-locks.ts     cancellation tokens + mutual-exclusion for long actions (goto/dig/collect/pvp/fish/smelt/craft)
  tools/
    lifecycle.ts movement.ts look.ts world.ts digging.ts combat.ts inventory.ts
    containers.ts furnace.ts enchant-anvil.ts villager.ts crafting.ts gathering.ts
    tool-select.ts survival.ts beds.ts vehicles.ts fishing-books-signs.ts chat.ts
    settings.ts creative.ts state-inspect.ts events.ts
  schemas/
    common.ts           shared Zod fragments: Vec3, blockName, itemName, entityFilter, format enum, goalSpec
  util/
    format.ts           concise/detailed serialization + truncation to CHARACTER_LIMIT
    errors.ts           toToolError, typed error codes (NOT_CONNECTED, NO_PATH, MISSING_TOOL, ...)
    resolve.ts          minecraft-data name<->id resolution for connected version + fuzzy suggestions
    serialize.ts        Block/Entity/Item/Recipe -> compact JSON (names over ids)
  resources/register.ts MCP resources + subscription wiring
eval/
  evaluation.xml        10 QA pairs against a seeded fixture (see §7)
  fixture.md            how to run the seeded test server
README.md  package.json  tsconfig.json
```

### BotManager status FSM
`disconnected → connecting → spawning → online → (reconnecting) → online | disconnected`
- `connect` resolves on `spawn`; rejects on `error`/`kicked`/timeout (`checkTimeoutInterval`). Microsoft device-code surfaced via `sendLoggingMessage`/notification (`onMsaCode`).
- Auto-reconnect (opt-in via connect option) on unexpected `end`/`kicked`, exponential backoff, capped retries; emits `reconnecting`/`reconnected` events.
- `ensureOnline()` guard on every action tool → `NOT_CONNECTED` error with guidance ("Call connect_bot first.").

### Concurrency / cancellation
A single action lock with named owners. Starting a new exclusive movement/combat action cancels the prior one cleanly. Long-running tools accept a `timeout` and resolve to typed outcomes (`{ ok, code, detail, partial }`). Cancellers: `stop_pathfinding`, `cancel_collect`, `pvp_stop`, `dig{action:"stop"}`, `autoeat_cancel`, `cancel_fish`, and a generic `cancel_task` for smelt/craft workflows.

### Window sessions
`open_container`/`open_furnace`/`open_villager`/`enchant_item`/`anvil_combine` establish **one** server-side open window. `read_open_container`/`container_deposit`/`container_withdraw`/`furnace_action`/`trade_with_villager`/`click_window`/`move_slot_item` act on the current window. `close_window` clears it. `windowOpen`/`windowClose` events keep the `open-window` resource in sync.

### Name resolution & serialization (critical for MCP)
Agents never pass prismarine `Item`/`Block`/`Entity`/`Recipe`/`Goal`/`Movements` objects or JS predicates. All identifiers are **human names** (e.g. `"diamond_ore"`, `"zombie"`) resolved to numeric ids via `minecraft-data` for the connected version; unknown names return fuzzy suggestions (`Unknown item 'dimond'. Did you mean: diamond, diamond_ore?`). Predicate-based APIs (`nearestEntity`, `findBlocks` matcher, `collectBlock.itemFilter`, `Movements.exclusionAreas`) are replaced by structured filters / name lists.

---

## 3. Tool catalog (~85 tools, 23 groups)

> Every tool: Zod raw-shape input schema, descriptive docstring (purpose/params/returns/errors), annotations (`readOnlyHint` for read tools, `openWorldHint` for lifecycle), `format: 'concise'|'detailed'` where it adds value (default concise), output truncated to `CHARACTER_LIMIT`.

### Lifecycle & Connection
- `connect_bot` — createBot + all connection opts: `host, port, username, password?, auth('offline'|'microsoft'|'mojang'), version?, brand?, respawn?, physicsEnabled?, viewDistance?, chat?, chatLengthLimit?, defaultChatPatterns?, disableChatSigning?, accessToken?, clientToken?, profilesFolder?, keepAlive?, checkTimeoutInterval?, logErrors?, hideErrors?, autoReconnect?`. Resolves on first spawn; device code via notification.
- `disconnect_bot` — `reason?, force?` (quit vs end).
- `reconnect_bot` — `overrideOptions?`.
- `respawn` — manual respawn after death.
- `get_connection_status` *(read)* — status FSM, username, version, kick/end reason, dimension.

### State & Inspection *(read-only)*
- `get_state` — consolidated self/world snapshot (position, velocity, yaw/pitch, onGround, health, food, saturation, oxygen, xp, gamemode, ping, time/day, weather, dimension, spawnPoint, heldItem, isDigging, usingHeldItem, isSleeping, vehicle, control states, active effects, physicsEnabled).
- `get_inventory` — items, slot indices, counts, held slot, armor/offhand, empty slots.
- `list_players` — roster: username, displayName, gamemode, ping, entity presence/position.
- `list_entities` — filtered: `type?/kind?/mobType?/username?/name?/maxDistance?/limit?`.
- `find_nearest_entity` — closest matching structured filter.
- `get_entity_details` *(new)* — one entity: equipment/held, armor, effects, attributes, metadata, pose, health, position, isValid.
- `get_scoreboards`, `get_teams`, `get_boss_bars` — read scoreboards/teams/boss bars.
- `get_control_states` — the seven movement booleans.
- `get_chat_patterns` — registered patterns.
- `support_feature` — `featureName` version-feature check.
- `pathfinder_status` — isMoving/isMining/isBuilding + last path metrics.
- `get_settings`, `get_physics` — client settings / physics constants.
- `get_loaded_plugins` *(new)* — which plugins loaded (`bot.hasPlugin`).

### World Queries *(read-only)*
- `get_block_at` — `x,y,z,extraInfos?` → block + canSee/canDig/digTime/signText.
- `find_blocks` — `matching(name|names), maxDistance?, count?, point?, useExtraInfo?` → positions (+closest block).
- `get_cursor_target` — raycast block/entity the bot (or `entityId`) looks at.
- `get_blocks_in_region` — bounded box scan, `matching?, maxCount?`.
- `wait_for_chunks_to_load` — await world load after spawn/teleport.

### Movement & Pathfinding
- `goto` — awaitable nav. `goalType('block'|'near'|'xz'|'nearxz'|'y'|'getToBlock'|'lookAtBlock'|'placeBlock'|'composite_any'|'composite_all'|'invert')`, coords/range, nested `goals[]` for composite/invert. Resolves on arrival; typed reject (`NO_PATH`/`TIMEOUT`/`GOAL_CHANGED`).
- `set_goal` — fire-and-forget; `dynamic?`.
- `flee_from` *(new)* — `x,y,z,distance` (GoalInvert(GoalNear)).
- `follow_entity` — `entityId, range?` (dynamic).
- `stop_pathfinding`.
- `get_path_to` *(read)* — dry-run feasibility/cost.
- `configure_movements` *(expanded)* — `scope('pathfinder'|'pvp'|'collectblock')` + full serializable Movements fields: `canDig, digCost, placeCost, maxDropDown, infiniteLiquidDropdownDistance, allowParkour, allowSprinting, allow1by1towers, allowFreeMotion, canOpenDoors, dontMineUnderFallingBlock, dontCreateFlow, entityCost, liquidCost, blocksToAvoid[], blocksCantBreak[], entitiesToAvoid[], passableEntities[], interactableBlocks[], climbables[], liquids[], replaceables[], scaffoldingBlocks[], gravityBlocks[], fences[], carpets[]` (block/entity name lists resolved to ids).
- `configure_pathfinder` — `thinkTimeout?, tickTimeout?, searchRadius?, enablePathShortcut?, LOSWhenPlacingBlocks?`.
- `set_control_state` — `control, state`.
- `clear_control_states`.
- `elytra_fly`, `wait_for_ticks`, `set_physics_enabled`.

### Look / Orientation
- `look_at` — `x,y,z,force?`.
- `look` — `yaw,pitch,force?` (radians).
- `look_at_entity` *(new)* — `entityId, force?`.

### Digging & Building
- `dig` — `x,y,z, forceLook?, digFace?('auto'|'raycast'|vec3), action?('start'|'stop')`; preflight canDig/digTime; guards concurrent digs.
- `place_block` — `referenceX/Y/Z, faceVector, itemName?, asEntity?` (placeBlock + placeEntity).
- `activate_block` — `x,y,z,direction?,cursorPos?`.
- `activate_entity` — `entityId, position?, useHeldItem?` (activateEntity/At + useOn).
- `swing_arm` — `hand?, showHand?` (cosmetic).

### Combat
- `pvp_attack` — kill-until-stopped loop; `entityId` or target filter, `followRange?, attackRange?`.
- `attack_entity` *(new)* — single `bot.attack(entityId, swing?)` (non-lethal/knockback/trigger).
- `pvp_stop` — `force?`.
- `pvp_configure` — `followRange?, attackRange?, viewDistance?, meleeMode?('maxDamage'|'fast')`.

### Inventory & Items
- `equip_item` — `item, destination('hand'|'head'|'torso'|'legs'|'feet'|'off-hand')`.
- `unequip_item` — `destination`.
- `toss_item` — `item?, count?, slot?` (toss + tossStack).
- `set_quickbar_slot` — `slot(0-8)`.
- `consume`.
- `activate_item` — `offHand?, action?('start'|'stop')` (activate + deactivate).
- `click_window` — `slot, mouseButton(0|1), mode(0-6)` (raw escape hatch).
- `move_slot_item` — `sourceSlot, destSlot?` (move + putAway).
- `transfer_items` — `item, count?, sourceRange?, destRange?, window?, nbt?`.

### Containers & Windows
- `open_container` — `x/y/z` OR `entityId`, `direction?, cursorPos?`.
- `read_open_container` *(read)*.
- `container_deposit` / `container_withdraw` — `item, count?, metadata?, nbt?`.
- `close_window`.

### Furnace / Smelting
- `open_furnace` — `x,y,z`.
- `furnace_action` — `slot('input'|'fuel'|'output'), op('put'|'take'), item?, count?`.
- `furnace_status` *(read)*.
- `smelt_item` — workflow: locate/open, load fuel+input, await progress, collect output. Cancellable via `cancel_task`.

### Enchanting & Anvil
- `enchant_item` — `x/y/z, item, lapisSlot?, choice?(0-2; omit to read options)`.
- `anvil_combine` — `x/y/z, itemOne, itemTwo?, name?` (combine/repair/rename).

### Villager Trading
- `open_villager` — `entityId` → trade list (awaits ready).
- `trade_with_villager` — `tradeIndex, times?`.

### Crafting
- `list_recipes` *(read)* — `item, includeUnavailable?, useCraftingTable?, minResultCount?`.
- `craft_item` — `item, count?, craftingTablePos?`. Cancellable via `cancel_task`.

### Block Gathering (collectblock)
- `collect_block` — flagship: `target(name|coords|entityId|array), count?, append?, ignoreNoPath?, chestLocations?, depositItems?/keepItems?`. Pathfind→tool-select→mine→pickup→auto-deposit. Typed outcomes (`NO_PATH`/`INVENTORY_FULL_NO_CHEST`).
- `cancel_collect`.
- `set_collect_config` — persistent `chestLocations?, depositItems?/keepItems?`.

### Tool Auto-Select
- `equip_tool_for_block` — `x/y/z` or `blockId`, `requireHarvest?, getFromChest?, maxTools?`.
- `set_tool_chest_locations` — `locations[], mode('set'|'add'|'clear')`.
- `get_best_tool` *(read)*.

### Survival Automation
- `autoeat_set_enabled` — `enabled`.
- `autoeat_configure` — `priority?('foodPoints'|'saturation'|'effectiveQuality'|'saturationRatio'), minHunger?, minHealth?, bannedFood?, returnToLastItem?, offhand?, eatingTimeout?, strictErrors?` (v5 `setOpts`).
- `autoeat_eat` — `food?, offhand?, equipOldItem?, priority?`.
- `autoeat_cancel`.
- `autoeat_preview` *(new, read)* — ranked food choices (`findBestChoices`).
- `armor_equip_all`.

### Beds & Sleep
- `sleep` — `x,y,z` (isABed validate + sleep).
- `wake`.

### Vehicles
- `mount_entity` — `entityId`.
- `dismount`.
- `steer_vehicle` — `left(-1|0|1), forward(-1|0|1)`.

### Fishing, Books & Signs
- `fish` — long-running; resolves on catch.
- `cancel_fish` *(new)*.
- `write_book` — `slot, pages[]`.
- `update_sign` — `x,y,z,text,back?` (read via get_block_at).

### Chat & Communication
- `chat` — `message`.
- `whisper` — `username, message`.
- `run_command` — `command` (slash escape hatch).
- `tab_complete` *(read)* — `text, assumeCommand?, sendBlockInSight?, timeout?`.
- `register_chat_pattern` — `name, pattern(string|string[]), repeat?, parse?` → emits `chat:<name>` into buffer.
- `remove_chat_pattern` — `nameOrId`.
- `wait_for_message` *(read)* — `patterns[], timeout?`.

### Settings
- `set_settings` — `viewDistance?, chat?, colorsEnabled?, difficulty?, skinParts?, mainHand?, enableTextFiltering?, enableServerListing?`.

### Creative Mode
- `creative_set_inventory_slot` — `slot, item?, count?, nbt?` (set/clear).
- `creative_clear_inventory`.
- `creative_fly` — `enabled`.
- `creative_fly_to` — `x,y,z`.

### Events & Telemetry
- `get_events` *(read)* — `since?, types?, limit?` → events + `nextSince` (drains buffer).
- `cancel_task` — cancel current generic long-running workflow (smelt/craft/etc.).

---

## 4. Event system

**Buffer (`get_events`, ring size 1000):** discrete, agent-actionable events:
`login, spawn, respawn, end, kicked, error, death, forcedMove, diggingCompleted, diggingAborted, blockPlaced, windowOpen, windowClose, mount, dismount, sleep, wake, playerJoined, playerLeft, entitySpawn(proximity), entityGone, itemDrop, playerCollect, entityHurt, entityDead, entityEffect/End, heldItemChanged, experience(level change), health/breath(significant change), bossBarCreated/Deleted, rain, weatherUpdate, resourcePack, title, soundEffectHeard(proximity), spawnReset, chunkColumnLoad/Unload(throttled), usedFirework, hardcodedSoundEffectHeard`, the reactive entity cluster `entityEquip/entitySwingArm/entitySleep/entityWake/entityTaming/entityTamed/entityCrouch/entityUncrouch/entityEat/entityHandSwap/entityElytraFlew/entityAttach/entityDetach`, pathfinder `goal_reached/path_update/path_reset/goal_updated`, pvp `startedAttacking/stoppedAttacking`, auto-eat `eatStart/eatFinish/eatFail`, and dynamic `chat:<name>` matches.

**Message feed:** `messagestr` (plain) + `jsonMsg` fidelity, tagged `chat/whisper/actionBar/system/game_info`.

**Push:** notable buffer entries → `sendLoggingMessage`; subscribed resources → `notifications/resources/updated`. All throttled ≤ 1 / 250 ms.

**Resource-only (re-read, not buffered — too high-frequency):** `time, move, entityMoved, entityUpdate, entityAttributes, blockUpdate(global), scoreboard*/team*/bossBarUpdated/playerUpdated, blockBreakProgress*, chestLidMove/pistonMove/noteHeard`. `physicsTick`/`particle` never surfaced. Per-coordinate `blockUpdate:(x,y,z)` only via optional `watch_block` subscription.

## 5. Resources (subscribe-capable)
`bot://state`, `bot://inventory`, `world://entities`, `world://players`, `bot://scoreboards`, `bot://teams`, `bot://bossbars`, `bot://settings`, `bot://physics`, `bot://open-window`, `bot://events` (tail). Server advertises `capabilities.resources = { subscribe: true }`, `logging: {}`.

## 6. Cross-cutting
- **Errors:** every handler wrapped → `{ isError:true, content:[{type:text,text}] }` with typed code + natural-language guidance; never throws raw.
- **Formatting:** concise default; detailed opt-in; human names over ids; truncation w/ "[truncated, N more]".
- **Tool-group toggles:** `MCP_DISABLE_GROUPS` env; unknown/disabled tool calls return guidance.

## 7. Testing & evaluation
- **Automated (no live world):** `tsc` typecheck/build; unit tests for EventBus ring buffer, name resolution + fuzzy-suggest, format/truncation, schema/registration smoke (all tools register, schemas compile), serialize helpers.
- **Live (documented, manual):** offline-mode server run-through; **no** Java-in-CI integration test (deliberate scope boundary).
- **Eval caveat:** mcp-builder evals want stable string-verifiable read-only answers; a *live* world isn't stable. `eval/evaluation.xml` targets read-only introspection against a **seeded fixture world** (documented in `eval/fixture.md`); evals require that seeded server. Stated honestly rather than shipping evals that pass against nothing.

## 8. Open risks / notes
- `bot.fish` has no first-class abort; `cancel_fish` implemented via re-activating the rod / internal interrupt — verify against 4.37 behavior during build.
- Microsoft auth in a headless MCP context relies on `profilesFolder` token cache; first run needs interactive device-code (surfaced via notification).
- ~85 tools is large; group toggles mitigate, but if the target client caps tools, recommend disabling `creative`, `villager`, `enchant-anvil`, `settings` first.
