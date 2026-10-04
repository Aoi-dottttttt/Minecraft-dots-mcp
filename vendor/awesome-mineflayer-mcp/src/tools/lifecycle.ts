/** Bot lifecycle & connection tools. */

import { z } from "zod";
import type { Registrar } from "./registry.js";
import type { ConnectOptions } from "../bot/manager.js";
import { ToolError } from "../util/errors.js";
import { resolveDefaultConnect } from "../account-config.js";

export function registerLifecycle(reg: Registrar): void {
  reg({
    name: "connect_bot",
    group: "lifecycle",
    description:
      "Connect the bot to a Minecraft server and wait until it spawns. Prerequisite for every other action tool. For Microsoft auth, a device-code prompt is emitted as an `msa_code` event / log notification; set `profilesFolder` to cache the token across runs.",
    inputSchema: {
      host: z.string().describe("Server hostname or IP"),
      port: z.number().int().min(1).max(65535).optional().describe("Server port (default 25565)"),
      username: z.string().describe("Account email (microsoft) or in-game name (offline)"),
      password: z.string().optional().describe("Account password (usually omit for microsoft device-code flow)"),
      auth: z.enum(["offline", "microsoft", "mojang"]).optional().describe("Auth mode (default offline)"),
      version: z.string().optional().describe('Force a protocol version, e.g. "1.20.4". Omit to auto-detect.'),
      brand: z.string().optional(),
      respawn: z.boolean().optional().describe("Auto-respawn on death (default true)"),
      physicsEnabled: z.boolean().optional(),
      viewDistance: z.enum(["far", "normal", "short", "tiny"]).optional(),
      chatLengthLimit: z.number().int().optional(),
      defaultChatPatterns: z.boolean().optional(),
      disableChatSigning: z.boolean().optional(),
      accessToken: z.string().optional().describe("Cached MSA access token (skip device-code flow)"),
      clientToken: z.string().optional(),
      profilesFolder: z.string().optional().describe("Directory to cache Microsoft auth tokens"),
      keepAlive: z.boolean().optional(),
      checkTimeoutInterval: z.number().int().optional().describe("ms before considering the connection timed out"),
      hideErrors: z.boolean().optional(),
      logErrors: z.boolean().optional(),
      autoReconnect: z.boolean().optional().describe("Automatically reconnect on unexpected disconnect (default false)"),
      connectTimeoutMs: z.number().int().optional().describe("Max ms to wait for spawn (default 30000)"),
    },
    annotations: { openWorldHint: true, title: "Connect bot" },
    handler: async (args, ctx) => ctx.manager.connect(args as unknown as ConnectOptions),
  });

  reg({
    name: "disconnect_bot",
    group: "lifecycle",
    description: "Disconnect the bot from the server. `force` uses a hard socket end instead of a graceful quit.",
    inputSchema: {
      reason: z.string().optional().describe("Quit reason string"),
      force: z.boolean().optional().describe("Hard end() instead of graceful quit() (default false)"),
    },
    annotations: { openWorldHint: true, title: "Disconnect bot" },
    handler: async (args, ctx) => ctx.manager.disconnect(args.reason ?? "disconnected by request", args.force ?? false),
  });

  reg({
    name: "reconnect_bot",
    group: "lifecycle",
    description: "Disconnect (if connected) and reconnect using the last connection options, optionally overriding some of them.",
    inputSchema: {
      overrideOptions: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Partial connect options to override (e.g. {host, port, version})"),
    },
    annotations: { openWorldHint: true, title: "Reconnect bot" },
    handler: async (args, ctx) => ctx.manager.reconnect(args.overrideOptions as Partial<ConnectOptions> | undefined),
  });

  reg({
    name: "respawn",
    group: "lifecycle",
    description: "Manually respawn after death (only needed when the bot was connected with respawn:false).",
    inputSchema: {},
    annotations: { title: "Respawn" },
    handler: async (_args, ctx) => {
      const bot = ctx.manager.requireBot();
      await bot.respawn();
      return { ok: true };
    },
  });

  reg({
    name: "get_connection_status",
    group: "lifecycle",
    description:
      "Report the connection lifecycle state (disconnected/connecting/online/reconnecting), username, version, dimension, vitals, position, and last end/kick reason. Safe to call when not connected.",
    inputSchema: {},
    annotations: { readOnlyHint: true, title: "Connection status" },
    handler: (_args, ctx) => ctx.manager.statusReport(),
  });

  reg({
    name: "connect_default",
    group: "lifecycle",
    description:
      "Connect using the pre-configured default account (from `awesome-mineflayer-mcp setup` or MCP_DEFAULT_* env vars). Takes no arguments. The server already auto-connects on startup when configured; use this to reconnect the default after a manual disconnect. Errors if no default is configured.",
    inputSchema: {},
    annotations: { openWorldHint: true, title: "Connect default account" },
    handler: async (_args, ctx) => {
      const def = resolveDefaultConnect();
      if (!def.opts) {
        throw new ToolError(
          "INVALID_ARGS",
          "No default account is configured. Run `awesome-mineflayer-mcp setup`, or set MCP_DEFAULT_HOST and MCP_DEFAULT_USERNAME.",
        );
      }
      return ctx.manager.connect(def.opts);
    },
  });

  reg({
    name: "get_default_account",
    group: "lifecycle",
    description:
      "Show the configured default account used for autonomous startup (host, port, username, auth mode, autoConnect). No passwords are stored or returned.",
    inputSchema: {},
    annotations: { readOnlyHint: true, title: "Get default account" },
    handler: () => {
      const def = resolveDefaultConnect();
      if (!def.account) return { configured: false };
      const a = def.account;
      return {
        configured: true,
        source: def.source,
        autoConnect: def.autoConnect,
        host: a.host,
        port: a.port ?? 25565,
        username: a.username,
        auth: a.auth,
        version: a.version ?? "auto",
        autoReconnect: a.autoReconnect ?? true,
        profilesFolder: a.profilesFolder ?? null,
      };
    },
  });
}
