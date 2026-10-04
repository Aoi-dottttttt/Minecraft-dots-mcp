/** Loads and exposes the six mineflayer ecosystem plugins. */

import type { Bot } from "mineflayer";
// These plugin packages are CommonJS: under Node ESM their named exports are
// not statically detectable, so we default-import the module object and
// destructure. esModuleInterop keeps this fully typed.
import pathfinderPkg from "mineflayer-pathfinder";
import pvpPkg from "mineflayer-pvp";
import collectblockPkg from "mineflayer-collectblock";
import toolPkg from "mineflayer-tool";
// mineflayer-auto-eat is ESM (named export `loader`, no default) — import it directly.
import { loader as autoEat } from "mineflayer-auto-eat";
import armorManager from "mineflayer-armor-manager";

const { pathfinder } = pathfinderPkg;
const { plugin: pvp } = pvpPkg;
const { plugin: collectBlock } = collectblockPkg;
const { plugin: toolPlugin } = toolPkg;

/** Plugin presence flags reported by `get_loaded_plugins`. */
export const PLUGIN_NAMES = [
  "pathfinder",
  "pvp",
  "collectBlock",
  "tool",
  "autoEat",
  "armorManager",
] as const;

export type PluginName = (typeof PLUGIN_NAMES)[number];

export function loadPlugins(bot: Bot): void {
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvp);
  bot.loadPlugin(collectBlock);
  bot.loadPlugin(toolPlugin);
  bot.loadPlugin(autoEat);
  bot.loadPlugin(armorManager);
}

/** Report which plugin namespaces are actually attached to the bot. */
export function loadedPlugins(bot: Bot): Record<PluginName, boolean> {
  const b = bot as unknown as Record<string, unknown>;
  return {
    pathfinder: b.pathfinder != null,
    pvp: b.pvp != null,
    collectBlock: b.collectBlock != null,
    tool: b.tool != null,
    autoEat: b.autoEat != null,
    armorManager: b.armorManager != null,
  };
}
