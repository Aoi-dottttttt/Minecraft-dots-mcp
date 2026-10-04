/**
 * Type shims for dependencies that ship no declarations.
 *
 * `mineflayer-armor-manager` is plain JS (module.exports = initializeBot) and
 * augments the bot with `bot.armorManager.equipAll()` at runtime only.
 *
 * NOTE: the top-level `export {}` makes this file a MODULE, so the
 * `declare module "mineflayer"` block below is treated as an *augmentation*
 * (merging into mineflayer's real Bot type) rather than an ambient replacement.
 */

export {};

declare module "mineflayer-armor-manager" {
  import type { Bot } from "mineflayer";
  const plugin: (bot: Bot) => void;
  export default plugin;
}

declare module "mineflayer" {
  interface Bot {
    armorManager: {
      equipAll: () => void;
    };
  }
}
