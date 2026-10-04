/** Assembles the McpServer: shared services, all tool groups, and resources. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_NAME, SERVER_VERSION } from "./config.js";
import { EventBus } from "./bot/events.js";
import { WindowManager } from "./bot/windows.js";
import { ActionLocks } from "./bot/action-locks.js";
import { BotManager } from "./bot/manager.js";
import type { ToolContext } from "./context.js";
import { makeRegistrar } from "./tools/registry.js";
import { registerResources } from "./resources/register.js";
import { registerPrompts } from "./prompts/register.js";

import { registerLifecycle } from "./tools/lifecycle.js";
import { registerStateInspect } from "./tools/state-inspect.js";
import { registerWorld } from "./tools/world.js";
import { registerMovement } from "./tools/movement.js";
import { registerLook } from "./tools/look.js";
import { registerDigging } from "./tools/digging.js";
import { registerCombat } from "./tools/combat.js";
import { registerInventory } from "./tools/inventory.js";
import { registerContainers } from "./tools/containers.js";
import { registerFurnace } from "./tools/furnace.js";
import { registerEnchantAnvil } from "./tools/enchant-anvil.js";
import { registerVillager } from "./tools/villager.js";
import { registerCrafting } from "./tools/crafting.js";
import { registerGathering } from "./tools/gathering.js";
import { registerToolSelect } from "./tools/tool-select.js";
import { registerSurvival } from "./tools/survival.js";
import { registerBeds } from "./tools/beds.js";
import { registerVehicles } from "./tools/vehicles.js";
import { registerFishingBooksSigns } from "./tools/fishing-books-signs.js";
import { registerChat } from "./tools/chat.js";
import { registerSettings } from "./tools/settings.js";
import { registerCreative } from "./tools/creative.js";
import { registerEvents } from "./tools/events.js";
import { registerVision } from "./tools/vision.js";
import { registerWaypoints } from "./tools/waypoints.js";
import { registerBuild } from "./tools/build.js";
import { registerRaw } from "./tools/raw.js";

export function buildServer(): { server: McpServer; ctx: ToolContext } {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: true, listChanged: false },
        prompts: {},
        logging: {},
      },
      instructions:
        "Control a single Mineflayer Minecraft bot. If a default account is configured (via `awesome-mineflayer-mcp setup` or MCP_DEFAULT_* env vars) the bot auto-connects on startup — check get_connection_status; otherwise call connect_bot (explicit credentials) or connect_default (the configured account). " +
        "Then use movement/mining/crafting/combat/etc. Poll get_events (with the returned nextSince) and get_state for game updates. Block/item/entity arguments accept human names. " +
        "Disable tool groups you don't need via the MCP_DISABLE_GROUPS env var.",
    },
  );

  const events = new EventBus();
  const windows = new WindowManager();
  const locks = new ActionLocks();
  const manager = new BotManager(events, windows, locks);
  const ctx: ToolContext = { server, manager, events, windows, locks };

  const reg = makeRegistrar(ctx);
  registerLifecycle(reg);
  registerStateInspect(reg);
  registerWorld(reg);
  registerMovement(reg);
  registerLook(reg);
  registerDigging(reg);
  registerCombat(reg);
  registerInventory(reg);
  registerContainers(reg);
  registerFurnace(reg);
  registerEnchantAnvil(reg);
  registerVillager(reg);
  registerCrafting(reg);
  registerGathering(reg);
  registerToolSelect(reg);
  registerSurvival(reg);
  registerBeds(reg);
  registerVehicles(reg);
  registerFishingBooksSigns(reg);
  registerChat(reg);
  registerSettings(reg);
  registerCreative(reg);
  registerEvents(reg);
  registerVision(reg);
  registerWaypoints(reg);
  registerBuild(reg);
  registerRaw(reg, ctx);

  registerResources(ctx);
  registerPrompts(ctx);

  return { server, ctx };
}
