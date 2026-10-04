/**
 * Library entry point — import the server programmatically instead of running
 * the bin. `import { buildServer } from "awesome-mineflayer-mcp"` gives you the
 * configured McpServer + ToolContext to wire into your own transport/host.
 *
 * (The CLI bin remains `dist/index.js`; importing this module has no side effects.)
 */

export { buildServer } from "./server.js";
export { BotManager } from "./bot/manager.js";
export type { ConnectOptions, ConnectionStatus } from "./bot/manager.js";
export { EventBus } from "./bot/events.js";
export type { GameEvent, DrainOptions, DrainResult } from "./bot/events.js";
export { ActionLocks } from "./bot/action-locks.js";
export { WindowManager } from "./bot/windows.js";
export type { ToolContext } from "./context.js";
export { SERVER_NAME, SERVER_VERSION } from "./config.js";
export { resolveDefaultConnect } from "./account-config.js";
