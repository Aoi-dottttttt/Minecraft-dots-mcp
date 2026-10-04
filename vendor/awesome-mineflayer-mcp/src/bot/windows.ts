/**
 * Tracks the single server-side open window/container session.
 *
 * mineflayer's `open*` helpers return specialised wrappers (Chest/Container,
 * Furnace, Villager, EnchantmentTable, Anvil) that expose extra methods beyond
 * the raw Window. We retain the last-opened wrapper so the per-window action
 * tools can operate on it, and clear it when the window closes.
 */

import type { Bot } from "mineflayer";
import { errors } from "../util/errors.js";

export type WindowKind = "container" | "furnace" | "villager" | "enchant" | "anvil";

export class WindowManager {
  private opened: unknown = null;
  private kind: WindowKind | null = null;
  private detach: (() => void) | null = null;

  /** Wire windowClose so the session is cleared automatically. */
  attach(bot: Bot): void {
    this.detachFromBot();
    const onClose = (): void => this.clear();
    bot.on("windowClose", onClose);
    this.detach = () => bot.removeListener("windowClose", onClose);
  }

  detachFromBot(): void {
    this.detach?.();
    this.detach = null;
    this.clear();
  }

  set(kind: WindowKind, obj: unknown): void {
    this.kind = kind;
    this.opened = obj;
  }

  clear(): void {
    this.kind = null;
    this.opened = null;
  }

  get currentKind(): WindowKind | null {
    return this.kind;
  }

  /** Return the open container (chest/barrel/etc.) wrapper or throw. */
  requireContainer(): any {
    if (!this.opened) throw errors.noWindow();
    return this.opened;
  }

  requireFurnace(): any {
    if (!this.opened || this.kind !== "furnace") throw errors.noWindow();
    return this.opened;
  }

  requireVillager(): any {
    if (!this.opened || this.kind !== "villager") throw errors.noWindow();
    return this.opened;
  }

  requireEnchant(): any {
    if (!this.opened || this.kind !== "enchant") throw errors.noWindow();
    return this.opened;
  }

  requireAnvil(): any {
    if (!this.opened || this.kind !== "anvil") throw errors.noWindow();
    return this.opened;
  }

  /** Any currently-open wrapper, or the bot's raw current window. */
  anyOrNull(): unknown {
    return this.opened;
  }
}
