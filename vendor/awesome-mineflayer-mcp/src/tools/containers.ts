/** Container / window interaction tools (chests, barrels, dispensers, etc.). */

import { z } from "zod";
import { Vec3 } from "vec3";
import type { Registrar } from "./registry.js";
import { itemRef } from "../schemas/common.js";
import { ToolError } from "../util/errors.js";
import { resolveItem } from "../util/resolve.js";
import { serializeItem } from "../util/serialize.js";
import { DEFAULT_ACTION_TIMEOUT_MS } from "../config.js";

/** Guard against acting on a window that has since closed (event missed / race). */
function assertWindowOpen(bot: unknown): void {
  if (!(bot as { currentWindow?: unknown }).currentWindow) {
    throw new ToolError("NO_WINDOW", "The container window is no longer open. Re-open it first.");
  }
}

export function registerContainers(reg: Registrar): void {
  reg({
    name: "open_container",
    group: "containers",
    description:
      "Open a chest/barrel/shulker/dispenser/hopper at a block coordinate (x,y,z) or a container entity (entityId, e.g. a chest minecart). Keeps the window open as the active container session for read_open_container / container_deposit / container_withdraw until close_window.",
    inputSchema: {
      x: z.number().optional().describe("X of the container block (omit if using entityId)"),
      y: z.number().optional().describe("Y of the container block"),
      z: z.number().optional().describe("Z of the container block"),
      entityId: z.number().int().optional().describe("Open a container entity instead of a block (e.g. chest minecart)"),
      direction: z
        .object({ x: z.number(), y: z.number(), z: z.number() })
        .optional()
        .describe("Optional face direction vector"),
      cursorPos: z
        .object({ x: z.number(), y: z.number(), z: z.number() })
        .optional()
        .describe("Optional cursor position on the block face"),
    },
    annotations: { title: "Open container" },
    timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      let target: unknown;
      if (args.entityId != null) {
        target = bot.entities[args.entityId];
        if (!target) throw new ToolError("NOT_FOUND", `No entity with id ${args.entityId} is currently tracked.`);
      } else {
        if (args.x == null || args.y == null || args.z == null) {
          throw new ToolError("INVALID_ARGS", "Provide either entityId or all of x, y, z.");
        }
        target = bot.blockAt(new Vec3(args.x, args.y, args.z));
        if (!target) throw new ToolError("NOT_FOUND", `No block at (${args.x}, ${args.y}, ${args.z}).`);
      }
      const direction = args.direction ? new Vec3(args.direction.x, args.direction.y, args.direction.z) : undefined;
      const cursorPos = args.cursorPos ? new Vec3(args.cursorPos.x, args.cursorPos.y, args.cursorPos.z) : undefined;
      const win = await bot.openContainer(target as any, direction as any, cursorPos as any);
      ctx.windows.set("container", win);
      const w = win as any;
      const items = typeof w.containerItems === "function" ? w.containerItems() : [];
      return {
        ok: true,
        type: w.type ?? null,
        items: items.map((i: any) => serializeItem(i)),
      };
    },
  });

  reg({
    name: "read_open_container",
    group: "containers",
    description:
      "Read the contents of the currently-open container: its own slots (containerItems) and the bot's inventory slots (inventoryItems). Throws NO_WINDOW if no container is open.",
    inputSchema: {},
    annotations: { readOnlyHint: true, title: "Read open container" },
    handler: (_args, ctx) => {
      ctx.manager.requireBot();
      const win = ctx.windows.requireContainer() as any;
      const containerItems =
        typeof win.containerItems === "function" ? win.containerItems().map((i: any) => serializeItem(i)) : [];
      const inventoryItems =
        typeof win.items === "function" ? win.items().map((i: any) => serializeItem(i)) : [];
      return { containerItems, inventoryItems };
    },
  });

  reg({
    name: "container_deposit",
    group: "containers",
    description:
      "Move items from the bot's inventory into the open container. Specify count to deposit a fixed amount, or omit to deposit all matching items.",
    inputSchema: {
      item: itemRef,
      count: z.number().int().min(1).optional().describe("How many to deposit (default all matching)"),
      metadata: z.number().int().optional().describe("Optional item metadata to match"),
    },
    annotations: { title: "Deposit into container" },
    timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const win = ctx.windows.requireContainer() as any;
      assertWindowOpen(bot);
      const id = resolveItem(bot.registry as any, args.item).id;
      await win.deposit(id, args.metadata ?? null, args.count ?? null);
      return { ok: true };
    },
  });

  reg({
    name: "container_withdraw",
    group: "containers",
    description:
      "Move items from the open container into the bot's inventory. Specify count to withdraw a fixed amount, or omit to withdraw all matching items.",
    inputSchema: {
      item: itemRef,
      count: z.number().int().min(1).optional().describe("How many to withdraw (default all matching)"),
      metadata: z.number().int().optional().describe("Optional item metadata to match"),
    },
    annotations: { title: "Withdraw from container" },
    timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const win = ctx.windows.requireContainer() as any;
      assertWindowOpen(bot);
      const id = resolveItem(bot.registry as any, args.item).id;
      await win.withdraw(id, args.metadata ?? null, args.count ?? null);
      return { ok: true };
    },
  });

  reg({
    name: "close_window",
    group: "containers",
    description:
      "Close the currently-open window/container session (chest, furnace, villager, enchant, anvil). Safe to call even if nothing is open.",
    inputSchema: {},
    annotations: { title: "Close window" },
    handler: (_args, ctx) => {
      const bot = ctx.manager.requireBot();
      const win = ctx.windows.anyOrNull() as any;
      if (win && typeof win.close === "function") {
        try {
          win.close();
        } catch {
          /* ignore close failures */
        }
      } else {
        const current = (bot as any).currentWindow;
        if (current) {
          try {
            bot.closeWindow?.(current);
          } catch {
            /* ignore */
          }
        }
      }
      ctx.windows.clear();
      return { ok: true };
    },
  });
}
