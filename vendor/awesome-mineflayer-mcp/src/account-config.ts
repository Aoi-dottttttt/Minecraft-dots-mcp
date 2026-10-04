/**
 * Persisted "default account" configuration for autonomous operation.
 *
 * Stored at ~/.awesome-mineflayer-mcp/config.json (override the directory with
 * AWESOME_MINEFLAYER_MCP_HOME). NO secrets are stored: offline needs none, and
 * Microsoft auth relies on the token cache under `profilesFolder` (managed by
 * prismarine-auth), not a saved password. Environment variables override the
 * file so MCP-client configs can set everything inline.
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { ConnectOptions } from "./bot/manager.js";

export function configHome(): string {
  const env = process.env.AWESOME_MINEFLAYER_MCP_HOME?.trim();
  return env && env.length > 0 ? env : path.join(os.homedir(), ".awesome-mineflayer-mcp");
}

export function configPath(): string {
  return path.join(configHome(), "config.json");
}

export function defaultProfilesFolder(): string {
  return path.join(configHome(), "profiles");
}

export interface StoredAccount {
  host: string;
  port?: number;
  username: string;
  auth: "offline" | "microsoft";
  version?: string;
  autoReconnect?: boolean;
  profilesFolder?: string;
}

export interface StoredConfig {
  account?: StoredAccount;
  autoConnect?: boolean;
}

export function loadConfig(): StoredConfig {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as StoredConfig) : {};
  } catch {
    return {};
  }
}

export function saveConfig(cfg: StoredConfig): string {
  fs.mkdirSync(configHome(), { recursive: true });
  const p = configPath();
  fs.writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return p;
}

function envBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return undefined;
}

export interface ResolvedDefault {
  /** ConnectOptions ready to pass to BotManager.connect, or null if unconfigured. */
  opts: ConnectOptions | null;
  /** Whether the server should auto-connect on startup. */
  autoConnect: boolean;
  /** Where the values came from. */
  source: "env" | "file" | "none";
  /** Sanitized account view for display (no secrets). */
  account: StoredAccount | null;
}

/** Merge stored config with environment overrides into ConnectOptions. */
export function resolveDefaultConnect(): ResolvedDefault {
  const cfg = loadConfig();
  const fileAcct = cfg.account ?? null;

  const host = process.env.MCP_DEFAULT_HOST?.trim() || fileAcct?.host;
  const username = process.env.MCP_DEFAULT_USERNAME?.trim() || fileAcct?.username;
  const authEnv = process.env.MCP_DEFAULT_AUTH?.trim();
  const auth: "offline" | "microsoft" =
    authEnv === "offline" || authEnv === "microsoft" ? authEnv : (fileAcct?.auth ?? "offline");

  if (!host || !username) {
    return { opts: null, autoConnect: false, source: "none", account: null };
  }

  const portEnv = process.env.MCP_DEFAULT_PORT;
  const portParsed = portEnv ? Number.parseInt(portEnv, 10) : fileAcct?.port;
  const port = portParsed && Number.isFinite(portParsed) ? portParsed : undefined;
  const version = process.env.MCP_DEFAULT_VERSION?.trim() || fileAcct?.version || undefined;
  const autoReconnect = envBool(process.env.MCP_DEFAULT_AUTO_RECONNECT) ?? fileAcct?.autoReconnect ?? true;
  const profilesFolder =
    process.env.MCP_PROFILES_FOLDER?.trim() ||
    fileAcct?.profilesFolder ||
    (auth === "microsoft" ? defaultProfilesFolder() : undefined);

  const opts: ConnectOptions = {
    host,
    username,
    auth,
    autoReconnect,
    ...(port !== undefined ? { port } : {}),
    ...(version ? { version } : {}),
    ...(profilesFolder ? { profilesFolder } : {}),
  };

  const usedEnv = Boolean(process.env.MCP_DEFAULT_HOST?.trim() || process.env.MCP_DEFAULT_USERNAME?.trim());
  const autoConnect = envBool(process.env.MCP_AUTO_CONNECT) ?? cfg.autoConnect ?? true;

  return {
    opts,
    autoConnect,
    source: usedEnv ? "env" : "file",
    account: { host, port, username, auth, version, autoReconnect, profilesFolder },
  };
}
