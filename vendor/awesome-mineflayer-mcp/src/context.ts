/** Shared context handed to every tool handler. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BotManager } from "./bot/manager.js";
import type { EventBus } from "./bot/events.js";
import type { WindowManager } from "./bot/windows.js";
import type { ActionLocks } from "./bot/action-locks.js";

export interface ToolContext {
  server: McpServer;
  manager: BotManager;
  events: EventBus;
  windows: WindowManager;
  locks: ActionLocks;
}
