/**
 * Typed, agent-friendly error handling.
 *
 * Tools never throw raw errors back to the MCP client. Instead every handler is
 * wrapped (see `util/result.ts`) so that thrown `ToolError`s — and any unexpected
 * exception — are converted into an `isError` result whose text carries a stable
 * machine code plus natural-language guidance the agent can act on.
 */

export type ErrorCode =
  | "NOT_CONNECTED" // no bot session is online
  | "ALREADY_CONNECTED" // a bot is already connected
  | "INVALID_ARGS" // arguments failed a semantic (not schema) check
  | "UNKNOWN_NAME" // a block/item/entity name could not be resolved
  | "NOT_FOUND" // a referenced block/entity/recipe does not exist in the world
  | "NO_PATH" // pathfinder could not reach the goal
  | "TIMEOUT" // an action exceeded its timeout
  | "GOAL_CHANGED" // navigation goal was superseded
  | "CANCELLED" // action was cancelled by the caller / a newer action
  | "BUSY" // another exclusive action is in progress
  | "MISSING_TOOL" // no suitable tool to dig/harvest
  | "MISSING_ITEM" // a required item is not in inventory
  | "MISSING_MATERIALS" // not enough materials for a recipe
  | "INVENTORY_FULL_NO_CHEST" // collect filled inventory with nowhere to deposit
  | "DIGGING_ABORTED" // dig was interrupted before completion
  | "NO_WINDOW" // no container/window is currently open
  | "PLUGIN_MISSING" // a required mineflayer plugin is not loaded
  | "UNSUPPORTED" // the action is not supported on this server/version/gamemode
  | "FORBIDDEN" // blocked by a configured safety policy (command/host allow-deny)
  | "CONNECT_REFUSED" // could not reach the server (refused / unresolved / unreachable)
  | "VERSION_MISMATCH" // client/server protocol versions differ
  | "ONLINE_MODE" // server is in online-mode and rejected the login
  | "AUTH_FAILED" // authentication (Microsoft/session) failed
  | "INTERNAL"; // an unexpected error

/** An error with a stable code and optional remediation suggestions. */
export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly suggestions?: string[];

  constructor(code: ErrorCode, message: string, suggestions?: string[]) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.suggestions = suggestions;
  }
}

/** Convenience constructors for the most common cases. */
export const errors = {
  notConnected: () =>
    new ToolError(
      "NOT_CONNECTED",
      "No bot is connected. Call `connect_bot` first.",
    ),
  pluginMissing: (plugin: string) =>
    new ToolError(
      "PLUGIN_MISSING",
      `The "${plugin}" plugin is not loaded, so this tool is unavailable.`,
    ),
  noWindow: () =>
    new ToolError(
      "NO_WINDOW",
      "No container/window is open. Open one first (e.g. `open_container`, `open_furnace`).",
    ),
  unknownName: (kind: string, query: string, suggestions: string[]) =>
    new ToolError(
      "UNKNOWN_NAME",
      `Unknown ${kind} "${query}".` +
        (suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""),
      suggestions,
    ),
};

/**
 * Map a raw connection failure reason (kick string / socket error message) to a
 * specific error code + actionable suggestions, so a login failure isn't an
 * opaque "INTERNAL". Falls back to INTERNAL for anything unrecognised.
 */
export function classifyConnectError(reason: string): { code: ErrorCode; suggestions: string[] } {
  const r = reason.toLowerCase();
  const has = (...needles: string[]): boolean => needles.some((n) => r.includes(n));

  if (has("econnrefused", "connection refused")) {
    return {
      code: "CONNECT_REFUSED",
      suggestions: [
        "Check the host and port are correct and the server is actually running.",
        "For a local server, confirm it has finished starting and is listening (default port 25565).",
      ],
    };
  }
  if (has("enotfound", "getaddrinfo", "eai_again", "dns")) {
    return {
      code: "CONNECT_REFUSED",
      suggestions: ["The hostname could not be resolved — double-check the server address."],
    };
  }
  if (has("etimedout", "ehostunreach", "enetunreach")) {
    return {
      code: "CONNECT_REFUSED",
      suggestions: ["The server was unreachable — check the address, port, and any firewall/whitelist."],
    };
  }
  if (has("outdated client", "outdated server", "unsupported protocol", "wrong version", "version is not supported")) {
    return {
      code: "VERSION_MISMATCH",
      suggestions: [
        "Pass an explicit `version` matching the server (e.g. version:\"1.20.4\") instead of relying on auto-detect.",
      ],
    };
  }
  if (has("unverified_username", "unverified username", "not whitelisted is set to true", "premium", "online mode", "online-mode")) {
    return {
      code: "ONLINE_MODE",
      suggestions: [
        "The server is in online-mode: connect with auth:\"microsoft\" (real account), or set online-mode=false on the server for offline auth.",
      ],
    };
  }
  if (has("multiplayer.disconnect.not_whitelisted", "not whitelisted", "you are not white-listed")) {
    return {
      code: "FORBIDDEN",
      suggestions: ["The bot's account is not on the server whitelist — add it (e.g. /whitelist add <name>)."],
    };
  }
  if (has("banned", "you are banned")) {
    return { code: "FORBIDDEN", suggestions: ["The bot's account is banned from this server."] };
  }
  if (has("invalid session", "bad login", "invalid credentials", "authentication", "msa", "xbox", "failed to authenticate")) {
    return {
      code: "AUTH_FAILED",
      suggestions: [
        "Re-run `awesome-mineflayer-mcp setup` to refresh the Microsoft token, or clear the profilesFolder cache and sign in again.",
      ],
    };
  }
  if (has("chat", "signing", "signature", "secure profile")) {
    return {
      code: "ONLINE_MODE",
      suggestions: ["Try connecting with disableChatSigning:true if the server rejects unsigned chat."],
    };
  }
  if (has("keepalive", "timed out", "timeout")) {
    return {
      code: "TIMEOUT",
      suggestions: ["The connection stalled — retry, or raise checkTimeoutInterval / connectTimeoutMs."],
    };
  }
  return { code: "INTERNAL", suggestions: [] };
}

/** Normalise any thrown value into a `{ code, message, suggestions }` shape. */
export function toToolError(e: unknown): {
  code: ErrorCode;
  message: string;
  suggestions?: string[];
} {
  if (e instanceof ToolError) {
    return { code: e.code, message: e.message, suggestions: e.suggestions };
  }
  if (e instanceof Error) {
    return { code: "INTERNAL", message: e.message };
  }
  return { code: "INTERNAL", message: String(e) };
}
