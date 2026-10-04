/**
 * Central configuration for the Mineflayer MCP server.
 *
 * All values are read from environment variables once at startup so the
 * behaviour is deterministic for the life of the process. Defaults are tuned
 * for an LLM agent's limited context window.
 */

export const SERVER_NAME = "awesome-mineflayer-mcp";
export const SERVER_VERSION = "1.3.2";

function readInt(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Hard ceiling on the characters returned by any single tool call. */
export const CHARACTER_LIMIT = readInt("MCP_CHARACTER_LIMIT", 25_000);

/** Maximum number of game events retained in the in-memory ring buffer. */
export const EVENT_BUFFER_SIZE = readInt("MCP_EVENT_BUFFER", 1_000);

/** Minimum spacing between pushed resource-update / log notifications. */
export const PUSH_THROTTLE_MS = readInt("MCP_THROTTLE_MS", 250);

/** Radius (blocks) used to decide whether a proximity-filtered event is buffered. */
export const PROXIMITY_RADIUS = readInt("MCP_PROXIMITY_RADIUS", 32);

/** Default timeout (ms) applied to long-running actions when the caller omits one. */
export const DEFAULT_ACTION_TIMEOUT_MS = readInt("MCP_ACTION_TIMEOUT_MS", 60_000);

/**
 * Tool groups that can be toggled off via `MCP_DISABLE_GROUPS` (comma separated).
 * Group names match the `group` passed to each tool-registration module.
 */
const disabledGroups: ReadonlySet<string> = new Set(
  (process.env.MCP_DISABLE_GROUPS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0),
);

export function isGroupEnabled(group: string): boolean {
  return !disabledGroups.has(group.toLowerCase());
}

export function listDisabledGroups(): string[] {
  return [...disabledGroups];
}

// --- Safety / guardrails ---------------------------------------------------

function envBool(envVar: string): boolean | undefined {
  const v = process.env[envVar];
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return undefined;
}

function csvLower(envVar: string): string[] {
  return (process.env[envVar] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Observe-only mode: when on, only read-only tools (+ the lifecycle group, so
 * the bot can still connect/disconnect) are registered. World-mutating tools
 * (dig, place, chat, combat, …) are not exposed at all.
 */
export const READ_ONLY = envBool("MCP_READ_ONLY") ?? false;

/**
 * Slash commands blocked by default — server-administration verbs that are
 * essentially never part of legitimate bot gameplay and are the main grief /
 * privilege-escalation vector if the bot happens to be op. Gameplay commands
 * (/tp, /time, /give, /gamemode, …) are NOT denied by default.
 *
 * Override semantics:
 *  - MCP_COMMAND_DENY set (even to "") REPLACES this list.
 *  - MCP_COMMAND_ALLOW set (non-empty) switches to strict allow-list mode
 *    (only those commands run; the deny list is ignored).
 */
const DEFAULT_COMMAND_DENY = [
  "op", "deop", "ban", "ban-ip", "pardon", "pardon-ip", "kick", "stop",
  "whitelist", "save-off", "save-on", "save-all", "setidletimeout",
  "debug", "reload", "perf", "jfr", "datapack", "forceload",
  // Command wrappers that could otherwise run a denied command (e.g.
  // `/execute run op @s`, `/function …`). The deny check is first-verb-only, so
  // these must be blocked too for the deny list to mean anything on an op'd bot.
  "execute", "function", "schedule",
];

const COMMAND_DENY: ReadonlySet<string> =
  process.env.MCP_COMMAND_DENY === undefined
    ? new Set(DEFAULT_COMMAND_DENY)
    : new Set(csvLower("MCP_COMMAND_DENY"));

const COMMAND_ALLOW: ReadonlySet<string> = new Set(csvLower("MCP_COMMAND_ALLOW"));

/**
 * Extract the bare command verb: "/minecraft:op Steve" -> "op".
 *
 * Strips ALL leading slashes and re-trims so a leading space or extra slash
 * ("  op X", "//op X", "/  op X") can't blank the verb and make the gate fail
 * open. Returns "" only for genuinely empty input.
 */
function commandName(command: string): string {
  const stripped = command.trim().replace(/^\/+/, "").trim();
  const first = stripped.split(/\s+/)[0] ?? "";
  return first.toLowerCase().replace(/^minecraft:/, "");
}

export function checkCommand(command: string): { allowed: boolean; reason?: string } {
  const name = commandName(command);
  if (!name) return { allowed: true };
  if (COMMAND_ALLOW.size > 0) {
    return COMMAND_ALLOW.has(name)
      ? { allowed: true }
      : { allowed: false, reason: `Command '${name}' is not in the MCP_COMMAND_ALLOW allow-list.` };
  }
  if (COMMAND_DENY.has(name)) {
    return {
      allowed: false,
      reason:
        `Command '${name}' is blocked by the command policy. ` +
        `Set MCP_COMMAND_DENY="" to allow all commands, or use MCP_COMMAND_ALLOW for a strict allow-list.`,
    };
  }
  return { allowed: true };
}

/** Optional connect host allow-list (empty => any host permitted). */
const ALLOWED_HOSTS = csvLower("MCP_ALLOWED_HOSTS");

export function checkHost(host: string): { allowed: boolean; reason?: string } {
  if (ALLOWED_HOSTS.length === 0) return { allowed: true };
  return ALLOWED_HOSTS.includes(host.trim().toLowerCase())
    ? { allowed: true }
    : {
        allowed: false,
        reason: `Host '${host}' is not in MCP_ALLOWED_HOSTS (${ALLOWED_HOSTS.join(", ")}).`,
      };
}

/** Minimum spacing (ms) between outbound chat/whisper/command sends. 0 = off. */
export const CHAT_MIN_INTERVAL_MS = readInt("MCP_CHAT_MIN_INTERVAL_MS", 0);

/**
 * Enable the advanced/unsafe `raw` tool group (direct protocol packet send +
 * subscribe). Off by default — raw packets bypass every other guardrail.
 */
export const RAW_ENABLED = envBool("MCP_ENABLE_RAW") ?? false;

// --- Screenshots (get_screenshot via prismarine-viewer + a headless browser) ---
export const SCREENSHOT_WIDTH = readInt("MCP_SCREENSHOT_WIDTH", 800);
export const SCREENSHOT_HEIGHT = readInt("MCP_SCREENSHOT_HEIGHT", 450);
/** How long to let the world render in the browser before capturing. */
export const SCREENSHOT_LOAD_MS = readInt("MCP_SCREENSHOT_LOAD_MS", 2500);
/** Chunk view distance the viewer renders. */
export const VIEW_DISTANCE = readInt("MCP_VIEW_DISTANCE", 4);
/** Playwright browser channel to launch (e.g. "chrome", "msedge"). Empty = auto-detect. */
export const SCREENSHOT_BROWSER_CHANNEL = (process.env.MCP_SCREENSHOT_BROWSER_CHANNEL ?? "").trim();
/** Explicit browser executable path (overrides channel). */
export const SCREENSHOT_EXECUTABLE_PATH = (process.env.MCP_SCREENSHOT_EXECUTABLE_PATH ?? "").trim();
