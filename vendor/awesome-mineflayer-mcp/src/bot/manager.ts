/**
 * BotManager — owns the single bot session and its lifecycle.
 *
 * Status FSM: disconnected → connecting → online → (reconnecting) → online | disconnected
 * Lifecycle (connect/disconnect/reconnect) and end/kicked handling live here.
 * Lifecycle + msa-code events are pushed to the EventBus so the resource/log
 * layer can forward them to the MCP client.
 */

import { createBot, type Bot } from "mineflayer";
import { ToolError, classifyConnectError } from "../util/errors.js";
import { checkHost } from "../config.js";
import { redactSecrets } from "../util/redact.js";
import type { EventBus } from "./events.js";
import type { WindowManager } from "./windows.js";
import type { ActionLocks } from "./action-locks.js";
import { loadPlugins } from "./plugins.js";
import { wireBotEvents } from "./wire-events.js";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "online"
  | "reconnecting";

export interface ConnectOptions {
  host: string;
  port?: number;
  username: string;
  password?: string;
  auth?: "offline" | "microsoft" | "mojang";
  /** Omit / empty string => auto-detect from server. */
  version?: string;
  brand?: string;
  respawn?: boolean;
  physicsEnabled?: boolean;
  viewDistance?: "far" | "normal" | "short" | "tiny";
  chatLengthLimit?: number;
  defaultChatPatterns?: boolean;
  disableChatSigning?: boolean;
  // Token-based / robustness options:
  accessToken?: string;
  clientToken?: string;
  profilesFolder?: string;
  keepAlive?: boolean;
  checkTimeoutInterval?: number;
  hideErrors?: boolean;
  logErrors?: boolean;
  // Manager behaviour:
  autoReconnect?: boolean;
  connectTimeoutMs?: number;
}

const RECONNECT_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000];
const MAX_RECONNECT_ATTEMPTS = RECONNECT_BACKOFF_MS.length;

export class BotManager {
  private _bot: Bot | null = null;
  private _status: ConnectionStatus = "disconnected";
  private lastOptions: ConnectOptions | null = null;
  private lastEndReason: string | null = null;
  private detachEvents: (() => void) | null = null;
  private intentionalQuit = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  constructor(
    private readonly events: EventBus,
    private readonly windows: WindowManager,
    private readonly locks: ActionLocks,
  ) {}

  get status(): ConnectionStatus {
    return this._status;
  }

  /** The active, spawned bot, or throw NOT_CONNECTED. */
  requireBot(): Bot {
    if (!this._bot || this._status !== "online") {
      throw new ToolError("NOT_CONNECTED", "No bot is connected. Call `connect_bot` first.");
    }
    return this._bot;
  }

  botOrNull(): Bot | null {
    return this._bot;
  }

  statusReport(): Record<string, unknown> {
    const bot = this._bot;
    return {
      status: this._status,
      username: bot?.username ?? this.lastOptions?.username ?? null,
      host: this.lastOptions?.host ?? null,
      port: this.lastOptions?.port ?? null,
      version: (bot as any)?.version ?? null,
      dimension: bot?.game?.dimension ?? null,
      health: bot?.health ?? null,
      food: bot?.food ?? null,
      position: bot?.entity?.position
        ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }
        : null,
      lastEndReason: this.lastEndReason,
      autoReconnect: this.lastOptions?.autoReconnect ?? false,
    };
  }

  async connect(opts: ConnectOptions): Promise<Record<string, unknown>> {
    if (this._bot) {
      throw new ToolError(
        "ALREADY_CONNECTED",
        `A bot (${this._bot.username}) is already connected. Call disconnect_bot or reconnect_bot first.`,
      );
    }
    this.assertHostAllowed(opts.host);
    // We may be mid-backoff (status "reconnecting", _bot null): cancel that timer
    // so it can't later spawn a duplicate, orphaned connection.
    this.cancelReconnectTimer();
    this.lastOptions = opts;
    this.reconnectAttempt = 0;
    this.intentionalQuit = false;
    await this.spawnBot(opts);
    return this.statusReport();
  }

  async disconnect(reason = "disconnected by request", force = false): Promise<Record<string, unknown>> {
    this.cancelReconnectTimer();
    const bot = this._bot;
    if (!bot) {
      // No live bot — but we may have been mid auto-reconnect backoff (status
      // "reconnecting"). The timer is now cancelled; land the FSM in a terminal
      // disconnected state so status isn't misreported as "reconnecting" forever.
      const wasReconnecting = this._status === "reconnecting";
      this.intentionalQuit = true;
      this.teardown("disconnected", reason);
      return {
        status: this._status,
        note: wasReconnecting ? "Cancelled pending reconnect." : "No bot was connected.",
      };
    }
    this.intentionalQuit = true;
    this.locks.cancelAll("manual");
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      bot.once("end", finish);
      setTimeout(finish, 3_000);
      try {
        if (force) bot.end(reason);
        else bot.quit(reason);
      } catch {
        finish();
      }
    });
    this.teardown("disconnected", reason);
    return { status: this._status, reason };
  }

  async reconnect(override?: Partial<ConnectOptions>): Promise<Record<string, unknown>> {
    if (!this.lastOptions) {
      throw new ToolError("INVALID_ARGS", "No previous connection to reconnect to. Use connect_bot.");
    }
    const opts = { ...this.lastOptions, ...(override ?? {}) };
    this.assertHostAllowed(opts.host);
    if (this._bot) {
      await this.disconnect("reconnecting", false);
    } else {
      // Mid-backoff with no live bot: clear the pending timer so it can't fire
      // after we spawn below.
      this.cancelReconnectTimer();
    }
    this.intentionalQuit = false;
    this.lastOptions = opts;
    this.reconnectAttempt = 0;
    await this.spawnBot(opts);
    return this.statusReport();
  }

  /** Best-effort shutdown for process exit. */
  shutdown(): void {
    this.cancelReconnectTimer();
    this.intentionalQuit = true;
    this.locks.cancelAll("shutdown");
    try {
      this._bot?.quit("server shutting down");
    } catch {
      /* ignore */
    }
    this.teardown("disconnected", "shutdown");
  }

  // --- internals ---

  private assertHostAllowed(host: string): void {
    const verdict = checkHost(host);
    if (!verdict.allowed) {
      throw new ToolError("FORBIDDEN", verdict.reason ?? `Host '${host}' is not permitted.`);
    }
  }

  /** Strip any configured secrets from a reason string before it leaves the process. */
  private redact(text: string): string {
    const o = this.lastOptions;
    return redactSecrets(text, [o?.password, o?.accessToken, o?.clientToken]);
  }

  /** Build a typed, actionable error from a raw connect/login failure reason. */
  private connectError(prefix: string, rawReason: string): ToolError {
    const reason = this.redact(rawReason);
    const { code, suggestions } = classifyConnectError(reason);
    return new ToolError(code, `${prefix}: ${reason}`, suggestions.length ? suggestions : undefined);
  }

  private buildBotOptions(opts: ConnectOptions): Record<string, unknown> {
    const o: Record<string, unknown> = {
      host: opts.host,
      username: opts.username,
      auth: opts.auth ?? "offline",
      onMsaCode: (data: { user_code?: string; verification_uri?: string; message?: string }) => {
        this.events.push("msa_code", {
          user_code: data?.user_code,
          verification_uri: data?.verification_uri,
          message: data?.message,
        });
      },
    };
    if (opts.port !== undefined) o.port = opts.port;
    if (opts.password !== undefined) o.password = opts.password;
    if (opts.version) o.version = opts.version; // falsy => auto
    if (opts.brand !== undefined) o.brand = opts.brand;
    if (opts.respawn !== undefined) o.respawn = opts.respawn;
    if (opts.physicsEnabled !== undefined) o.physicsEnabled = opts.physicsEnabled;
    if (opts.viewDistance !== undefined) o.viewDistance = opts.viewDistance;
    if (opts.chatLengthLimit !== undefined) o.chatLengthLimit = opts.chatLengthLimit;
    if (opts.defaultChatPatterns !== undefined) o.defaultChatPatterns = opts.defaultChatPatterns;
    if (opts.disableChatSigning !== undefined) o.disableChatSigning = opts.disableChatSigning;
    if (opts.accessToken !== undefined) o.accessToken = opts.accessToken;
    if (opts.clientToken !== undefined) o.clientToken = opts.clientToken;
    if (opts.profilesFolder !== undefined) o.profilesFolder = opts.profilesFolder;
    if (opts.keepAlive !== undefined) o.keepAlive = opts.keepAlive;
    if (opts.checkTimeoutInterval !== undefined) o.checkTimeoutInterval = opts.checkTimeoutInterval;
    if (opts.hideErrors !== undefined) o.hideErrors = opts.hideErrors;
    if (opts.logErrors !== undefined) o.logErrors = opts.logErrors;
    return o;
  }

  private spawnBot(opts: ConnectOptions): Promise<void> {
    this.setStatus("connecting");
    const bot = createBot(this.buildBotOptions(opts) as any);
    this._bot = bot;
    // NOTE: intentionalQuit is reset by the intentional entry points
    // (connect/reconnect), NOT here — otherwise a manual disconnect that lands
    // while an auto-reconnect spawn is in flight would be silently undone.

    loadPlugins(bot);
    this.windows.attach(bot);
    this.detachEvents = wireBotEvents(bot, this.events);
    this.attachLifecycle(bot);

    const timeoutMs = opts.connectTimeoutMs ?? 30_000;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        bot.removeListener("spawn", onSpawn);
        bot.removeListener("error", onError);
        bot.removeListener("kicked", onKicked);
        bot.removeListener("end", onEnd);
      };
      const onSpawn = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.setStatus("online");
        resolve();
      };
      const onError = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        const r = err?.message ?? String(err);
        this.teardown("disconnected", this.redact(r));
        reject(this.connectError("Failed to connect", r));
      };
      const onKicked = (reason: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        const r = stringifyReason(reason);
        this.teardown("disconnected", this.redact(r));
        reject(this.connectError("Kicked during login", r));
      };
      const onEnd = (reason: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        const r = stringifyReason(reason);
        this.teardown("disconnected", this.redact(r));
        reject(this.connectError("Connection ended during login", r));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          bot.end("connect timeout");
        } catch {
          /* ignore */
        }
        this.teardown("disconnected", "connect timeout");
        reject(new ToolError("TIMEOUT", `Did not spawn within ${timeoutMs}ms.`));
      }, timeoutMs);

      bot.once("spawn", onSpawn);
      bot.once("error", onError);
      bot.once("kicked", onKicked);
      bot.once("end", onEnd);
    });
  }

  /** Permanent end/kicked handling (active after a successful spawn). */
  private attachLifecycle(bot: Bot): void {
    bot.on("kicked", (reason: unknown) => {
      // Only act once online; login-window kicks are handled by the spawn Promise.
      if (this._bot !== bot || this._status !== "online") return;
      const r = this.redact(stringifyReason(reason));
      this.lastEndReason = `kicked: ${r}`;
      this.events.push("kicked", { reason: r });
    });
    bot.on("end", (reason: unknown) => {
      // Only act once online; login-window ends are handled by the spawn Promise,
      // so we avoid double-incrementing the reconnect counter / spurious events.
      if (this._bot !== bot || this._status !== "online") return;
      const r = this.redact(stringifyReason(reason));
      this.events.push("end", { reason: r });
      if (this.intentionalQuit) {
        this.teardown("disconnected", r);
        return;
      }
      this.lastEndReason = r;
      if (this.lastOptions?.autoReconnect) {
        this.scheduleReconnect();
      } else {
        this.teardown("disconnected", r);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.intentionalQuit) {
      // A manual disconnect / shutdown landed while a reconnect was in flight.
      // Honour it instead of reconnecting anyway.
      this.teardown("disconnected", this.lastEndReason);
      return;
    }
    this.detachAndClearBot();
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      this.setStatus("disconnected");
      this.events.push("reconnect_failed", { attempts: this.reconnectAttempt });
      return;
    }
    const delay = RECONNECT_BACKOFF_MS[this.reconnectAttempt] ?? 30_000;
    this.reconnectAttempt += 1;
    this.setStatus("reconnecting");
    this.events.push("reconnecting", { attempt: this.reconnectAttempt, delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.lastOptions || this.intentionalQuit) return;
      this.spawnBot(this.lastOptions).then(
        () => {
          this.reconnectAttempt = 0;
          this.events.push("reconnected", null);
        },
        () => {
          this.scheduleReconnect();
        },
      );
    }, delay);
  }

  private cancelReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.events.push("status", { status });
  }

  private detachAndClearBot(): void {
    this.detachEvents?.();
    this.detachEvents = null;
    this.windows.detachFromBot();
    this._bot = null;
  }

  private teardown(status: ConnectionStatus, reason: string | null): void {
    this.cancelReconnectTimer();
    this.detachAndClearBot();
    this.lastEndReason = reason;
    this.setStatus(status);
  }
}

function stringifyReason(reason: unknown): string {
  if (reason == null) return "unknown";
  if (typeof reason === "string") return reason;
  try {
    const s = (reason as { toString?: () => string }).toString?.();
    if (s && s !== "[object Object]") return s;
  } catch {
    /* fall through */
  }
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}
