# Capability and evidence matrix

This is an inventory of the guarded backend catalog, not a claim that every tool works end to end. Aliases are separate catalog entries and do not multiply independent capabilities. Current pass/fail results belong in [VALIDATION.json](../VALIDATION.json). The frontend separately adds the read-only `get-controller-status` attachment report.

## Evidence levels

- `catalog-only`: the tool is exposed by the networkless runtime catalog; no dedicated per-tool behavior fixture is asserted by this table
- `dedicated-fixture`: the linked neutral regression exercises a relevant behavior or guard, not every argument, server plugin or complete gameplay outcome

The checker keeps names synchronized with CAPABILITIES.json and requires each referenced test file to exist. It does not turn the table into a test pass or real-server certification.

## Remaining boundaries

- Inventory confirmation remains strict. Fuel consumption evidence covers coal/charcoal and exact 300-tick birch planks in ordinary furnaces; other fuels, remainders, re-ignition and background changes do not gain a general exception
- Placement provenance records newly verified placements within one continuously observed session. An old coordinate, block type, or historical note cannot establish ownership
- A supported window layout proves slot mapping, not every workstation recipe or workflow. Brewing, smithing, loom and cartography require their own effect fixtures before stronger claims
- Movement now includes conservative water/oxygen guards and special-terrain fixtures; unusual collision and real swimming remain separately unvalidated. The merged open-wooden-door repair is included
- Vehicle input and mounting are partial. Full boat placement, riding and steering is not validated; sending `steer_vehicle` input does not implement a complete vehicle physics controller
- Books/signs/chat are untrusted player-authored data. `read-book` closes an observation gap, while writing a book still requires subsequent authoritative readback to establish its final contents
- Projectile, advanced combat, redstone, farming and unusual entity interactions are not certified merely by generic interaction tools
- Modded-server compatibility depends on each server's protocol and required channels. A legacy Forge handshake plugin is not evidence of Minecraft 1.21.1 mod compatibility

## Primary implementation references

These are upstream implementation references, not a Mojang protocol specification. The installed dependency versions remain pinned by both lockfiles.

- [PrismarineJS 1.21.1 version data](https://github.com/PrismarineJS/minecraft-data/blob/master/data/pc/1.21.1/version.json) and [book/protocol schemas](https://github.com/PrismarineJS/minecraft-data/blob/master/data/pc/1.21.1/protocol.json)
- [Mineflayer API](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md), [entity/vehicle input](https://github.com/PrismarineJS/mineflayer/blob/master/lib/plugins/entities.js), and [player physics](https://github.com/PrismarineJS/mineflayer/blob/master/lib/plugins/physics.js)
- [Pathfinder movement implementation](https://github.com/PrismarineJS/mineflayer-pathfinder/blob/master/lib/movements.js)
- [Forge channel compatibility rules](https://docs.minecraftforge.net/en/1.21.x/networking/simpleimpl/) and [legacy protocol-forge scope](https://github.com/PrismarineJS/node-minecraft-protocol-forge)

## Local observation outside the MCP catalog

The opt-in dashboard/3D service is not an extra gameplay tool. HTTP/socket privacy and lifecycle tests are in `tests/readonly-observer.test.ts`; adapted 1.21.1 worker geometry at negative and high Y is checked by `scripts/test-observer-worker.mjs`. Browser pixel evidence requires the dedicated CI job. See [observer boundaries](READONLY-OBSERVER.md).

## Exact backend tool inventory

| Tool | Family | Evidence level | Fixture |
| --- | --- | --- | --- |
| `get-position` | Observation | catalog-only | — |
| `move-to-position` | Movement | dedicated-fixture | `tests/open-door-navigation.test.cjs` |
| `look-at` | Movement | catalog-only | — |
| `jump` | Movement | catalog-only | — |
| `move-in-direction` | Movement | catalog-only | — |
| `place-block` | Blocks and building | dedicated-fixture | `tests/survival-interactions.test.ts` |
| `dig-block` | Blocks and building | dedicated-fixture | `tests/native-ore-policy.test.ts` |
| `get-block-info` | Observation | catalog-only | — |
| `find-blocks` | Observation | catalog-only | — |
| `list-inventory` | Observation | catalog-only | — |
| `find-item` | Observation | catalog-only | — |
| `equip-item` | Inventory | catalog-only | — |
| `list-recipes` | Crafting | catalog-only | — |
| `craft-item` | Crafting | catalog-only | — |
| `get-recipe` | Crafting | catalog-only | — |
| `can-craft` | Crafting | catalog-only | — |
| `find-entity` | Observation | catalog-only | — |
| `detect-gamemode` | Observation | catalog-only | — |
| `smelt-item` | Furnaces and workstations | dedicated-fixture | `tests/verified-furnace.test.ts` |
| `send-chat` | Text and events | dedicated-fixture | `scripts/test-fenced-plain-chat.mjs` |
| `read-chat` | Observation | catalog-only | — |
| `get-session-status` | Observation | catalog-only | — |
| `inspect-nearby` | Observation | catalog-only | — |
| `consume-food` | Survival | catalog-only | — |
| `attack-mob` | Combat | catalog-only | — |
| `stop-movement` | Movement | catalog-only | — |
| `respawn-player` | Session | catalog-only | — |
| `disconnect-player` | Session | catalog-only | — |
| `get_state` | Observation | catalog-only | — |
| `get_inventory` | Observation | catalog-only | — |
| `get_observation` | Observation | catalog-only | — |
| `list_players` | Observation | catalog-only | — |
| `list_entities` | Observation | catalog-only | — |
| `find_nearest_entity` | Observation | catalog-only | — |
| `get_entity_details` | Observation | catalog-only | — |
| `get_scoreboards` | Observation | catalog-only | — |
| `get_teams` | Observation | catalog-only | — |
| `get_boss_bars` | Observation | catalog-only | — |
| `get_control_states` | Observation | catalog-only | — |
| `get_chat_patterns` | Observation | catalog-only | — |
| `support_feature` | Observation | catalog-only | — |
| `pathfinder_status` | Observation | catalog-only | — |
| `get_settings` | Observation | catalog-only | — |
| `get_physics` | Observation | catalog-only | — |
| `get_loaded_plugins` | Observation | catalog-only | — |
| `get_block_at` | Observation | catalog-only | — |
| `find_blocks` | Observation | catalog-only | — |
| `get_cursor_target` | Observation | catalog-only | — |
| `get_blocks_in_region` | Observation | catalog-only | — |
| `wait_for_chunks_to_load` | Observation | catalog-only | — |
| `goto` | Movement | dedicated-fixture | `tests/movement-safety.test.ts` |
| `set_goal` | Movement | catalog-only | — |
| `flee_from` | Movement | catalog-only | — |
| `follow_entity` | Movement | catalog-only | — |
| `stop_pathfinding` | Movement | catalog-only | — |
| `get_path_to` | Movement | catalog-only | — |
| `set_control_state` | Movement | catalog-only | — |
| `clear_control_states` | Movement | catalog-only | — |
| `elytra_fly` | Movement | catalog-only | — |
| `wait_for_ticks` | Movement | catalog-only | — |
| `look_at` | Movement | catalog-only | — |
| `look` | Movement | catalog-only | — |
| `look_at_entity` | Movement | catalog-only | — |
| `dig` | Blocks and building | catalog-only | — |
| `place_block` | Blocks and building | catalog-only | — |
| `activate_block` | Blocks and building | catalog-only | — |
| `activate_entity` | Blocks and building | catalog-only | — |
| `swing_arm` | Blocks and building | catalog-only | — |
| `pvp_attack` | Combat | catalog-only | — |
| `attack_entity` | Combat | catalog-only | — |
| `pvp_stop` | Combat | catalog-only | — |
| `pvp_configure` | Combat | catalog-only | — |
| `equip_item` | Inventory | catalog-only | — |
| `unequip_item` | Inventory | catalog-only | — |
| `toss_item` | Inventory | catalog-only | — |
| `set_quickbar_slot` | Inventory | catalog-only | — |
| `consume` | Survival | catalog-only | — |
| `activate_item` | Survival | catalog-only | — |
| `click_window` | Inventory | catalog-only | — |
| `move_slot_item` | Inventory | catalog-only | — |
| `transfer_items` | Inventory | catalog-only | — |
| `open_container` | Containers | catalog-only | — |
| `read_open_container` | Containers | catalog-only | — |
| `container_deposit` | Containers | catalog-only | — |
| `container_withdraw` | Containers | catalog-only | — |
| `close_window` | Containers | catalog-only | — |
| `open_furnace` | Furnaces and workstations | catalog-only | — |
| `furnace_action` | Furnaces and workstations | dedicated-fixture | `tests/verified-furnace-fuel-race.test.ts` |
| `furnace_status` | Furnaces and workstations | catalog-only | — |
| `smelt_item` | Furnaces and workstations | catalog-only | — |
| `enchant_item` | Furnaces and workstations | dedicated-fixture | `tests/reviewer-complete-controls.test.ts` |
| `anvil_combine` | Furnaces and workstations | dedicated-fixture | `tests/reviewer-complete-controls.test.ts` |
| `open_villager` | Furnaces and workstations | dedicated-fixture | `tests/reviewer-complete-controls.test.ts` |
| `trade_with_villager` | Furnaces and workstations | dedicated-fixture | `tests/reviewer-complete-controls.test.ts` |
| `list_recipes` | Crafting | catalog-only | — |
| `craft_item` | Crafting | dedicated-fixture | `tests/review-capability-gaps.test.ts` |
| `collect_block` | Blocks and building | catalog-only | — |
| `cancel_collect` | Blocks and building | catalog-only | — |
| `set_collect_config` | Blocks and building | catalog-only | — |
| `equip_tool_for_block` | Blocks and building | catalog-only | — |
| `set_tool_chest_locations` | Blocks and building | catalog-only | — |
| `get_best_tool` | Blocks and building | catalog-only | — |
| `autoeat_set_enabled` | Survival | catalog-only | — |
| `autoeat_configure` | Survival | catalog-only | — |
| `autoeat_eat` | Survival | dedicated-fixture | `tests/native-plugin-startup.test.ts` |
| `autoeat_cancel` | Survival | catalog-only | — |
| `autoeat_preview` | Survival | catalog-only | — |
| `armor_equip_all` | Survival | catalog-only | — |
| `sleep` | Survival | catalog-only | — |
| `wake` | Survival | catalog-only | — |
| `mount_entity` | Vehicles | catalog-only | — |
| `dismount` | Vehicles | catalog-only | — |
| `steer_vehicle` | Vehicles | catalog-only | — |
| `fish` | Survival | catalog-only | — |
| `cancel_fish` | Survival | catalog-only | — |
| `write_book` | Text and events | dedicated-fixture | `tests/review-capability-gaps.test.ts` |
| `update_sign` | Text and events | catalog-only | — |
| `chat` | Text and events | catalog-only | — |
| `whisper` | Text and events | catalog-only | — |
| `tab_complete` | Text and events | catalog-only | — |
| `remove_chat_pattern` | Text and events | catalog-only | — |
| `get_events` | Text and events | catalog-only | — |
| `cancel_task` | Text and events | catalog-only | — |
| `render_map` | Local helpers | catalog-only | — |
| `set_waypoint` | Local helpers | catalog-only | — |
| `list_waypoints` | Local helpers | catalog-only | — |
| `delete_waypoint` | Local helpers | catalog-only | — |
| `goto_waypoint` | Local helpers | catalog-only | — |
| `clear_region` | Blocks and building | catalog-only | — |
| `dig_tunnel` | Blocks and building | catalog-only | — |
| `dig_staircase` | Blocks and building | catalog-only | — |
| `fill_region` | Blocks and building | catalog-only | — |
| `equip-inventory-slot` | Inventory | dedicated-fixture | `tests/review-capability-gaps.test.ts` |
| `inspect-block-properties` | Observation | catalog-only | — |
| `activate-block` | Blocks and building | dedicated-fixture | `tests/survival-interactions.test.ts` |
| `use-item-on-block` | Blocks and building | dedicated-fixture | `tests/survival-interactions.test.ts` |
| `use-held-item` | Survival | dedicated-fixture | `tests/survival-interactions.test.ts` |
| `stop-using-item` | Survival | catalog-only | — |
| `sleep-in-bed` | Survival | dedicated-fixture | `tests/survival-interactions.test.ts` |
| `wake-up` | Survival | catalog-only | — |
| `set-bed-respawn` | Survival | catalog-only | — |
| `farm-block` | Blocks and building | dedicated-fixture | `tests/survival-interactions.test.ts` |
| `use-item-on-animal` | Survival | dedicated-fixture | `tests/survival-interactions.test.ts` |
| `mount-entity` | Vehicles | dedicated-fixture | `tests/survival-interactions.test.ts` |
| `dismount-vehicle` | Vehicles | dedicated-fixture | `tests/survival-interactions.test.ts` |
| `steer-vehicle` | Vehicles | dedicated-fixture | `tests/survival-interactions.test.ts` |
| `open-container` | Containers | dedicated-fixture | `tests/window-opening-preflight.test.ts` |
| `open-furnace` | Furnaces and workstations | dedicated-fixture | `tests/window-opening-preflight.test.ts` |
| `open-workstation` | Furnaces and workstations | dedicated-fixture | `tests/window-opening-preflight.test.ts` |
| `read-open-container` | Containers | catalog-only | — |
| `close-window` | Containers | catalog-only | — |
| `furnace-status` | Furnaces and workstations | dedicated-fixture | `tests/verified-window-actions.test.ts` |
| `furnace-action` | Furnaces and workstations | dedicated-fixture | `tests/verified-furnace-fuel-race.test.ts` |
| `container-deposit` | Containers | dedicated-fixture | `tests/verified-window-actions.test.ts` |
| `container-withdraw` | Containers | dedicated-fixture | `tests/verified-window-actions.test.ts` |
| `transfer-window-items` | Inventory | catalog-only | — |
| `click-window` | Inventory | dedicated-fixture | `tests/verified-window-actions.test.ts` |
| `select-window-option` | Furnaces and workstations | dedicated-fixture | `tests/verified-window-actions.test.ts` |
| `read-book` | Text and events | dedicated-fixture | `tests/book-observation.test.ts` |
| `move-controls` | Movement | catalog-only | — |
| `list-gameplay-capabilities` | Observation | catalog-only | — |
| `game-command` | Text and events | catalog-only | — |
| `inspect-movement-safety` | Movement | dedicated-fixture | `tests/movement-safety.test.ts` |
| `surface-from-water` | Movement | dedicated-fixture | `tests/movement-safety.test.ts` |
| `launch-boat` | Movement | dedicated-fixture | `tests/verified-boat.test.ts` |
| `plan-gather-workflow` | Bounded workflows | dedicated-fixture | `tests/workflow-tools.test.ts` |
| `plan-blueprint-workflow` | Bounded workflows | dedicated-fixture | `tests/workflow-tools.test.ts` |
| `read-workflow` | Bounded workflows | dedicated-fixture | `tests/workflow-tools.test.ts` |
| `run-workflow` | Bounded workflows | dedicated-fixture | `tests/workflow-tools.test.ts` |
| `cancel-workflow` | Bounded workflows | dedicated-fixture | `tests/workflow-tools.test.ts` |
| `self-defense-enable` | Reactive self-defense | dedicated-fixture | `tests/self-defense.test.ts` |
| `self-defense-disable` | Reactive self-defense | dedicated-fixture | `tests/self-defense.test.ts` |
| `self-defense-status` | Reactive self-defense | dedicated-fixture | `tests/self-defense.test.ts` |
