// Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { pathfinder, Movements } = pathfinderPkg;
import minecraftData from 'minecraft-data';
import { installInventoryAuthority, getInventoryAuthority } from './inventory-authority.js';

type ConnectionState = 'connected' | 'connecting' | 'disconnected';

interface BotConfig {
  host: string;
  port: number;
  username: string;
  version?: string;
  auth?: 'offline';
}

interface ConnectionCallbacks {
  onLog: (level: string, message: string) => void;
  onChatMessage: (username: string, message: string) => void;
}

export class BotConnection {
  private bot: mineflayer.Bot | null = null;
  private state: ConnectionState = 'disconnected';
  private config: BotConfig;
  private callbacks: ConnectionCallbacks;
  private started = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: BotConfig, callbacks: ConnectionCallbacks, _reconnectDelayMs = 2000) {
    this.config = config;
    this.callbacks = callbacks;
    void _reconnectDelayMs;
  }

  getBot(): mineflayer.Bot | null {
    return this.bot;
  }

  getState(): ConnectionState {
    return this.state;
  }

  getConfig(): BotConfig {
    return this.config;
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  connect(): void {
    if (this.started) throw new Error('Automatic reconnect is disabled; a fresh user-triggered launch is required');
    this.started = true;
    const botOptions = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      plugins: { pathfinder },
      version: this.config.version ?? '1.21.1',
      auth: this.config.auth ?? 'offline' as const,
      hideErrors: true, logErrors: false, respawn: false,
    };

    this.bot = mineflayer.createBot(botOptions);
    this.state = 'connecting';
    installInventoryAuthority(this.bot);

    this.registerEventHandlers(this.bot);
  }

  private registerEventHandlers(bot: mineflayer.Bot): void {
    bot.once('spawn', async () => {
      this.state = 'connected';
      this.callbacks.onLog('info', 'Bot spawned in world');

      const mcData = minecraftData(bot.version);
      const defaultMove = new Movements(bot, mcData);
      Object.assign(defaultMove, { canDig: false, allow1by1towers: false, allowParkour: false, allowFreeMotion: false, maxDropDown: 2, scafoldingBlocks: [] });
      bot.pathfinder.setMovements(defaultMove);

      this.callbacks.onLog('info', `Bot connected successfully. Username: ${this.config.username}, Server: ${this.config.host}:${this.config.port}`);
    });

    bot.on('chat', (username, message) => {
      if (username === bot.username) return;
      this.callbacks.onChatMessage(username, message);
    });

    bot.on('kicked', (reason) => {
      this.callbacks.onLog('error', `Bot was kicked from server: ${this.formatError(reason)}`);
      this.state = 'disconnected';
      bot.quit();
    });

    bot.on('error', (err) => {
      const errorCode = (err as { code?: string }).code || 'Unknown error';
      const errorMsg = err instanceof Error ? err.message : String(err);

      this.callbacks.onLog('error', `Bot error [${errorCode}]: ${errorMsg}`);

      if (errorCode === 'ECONNREFUSED' || errorCode === 'ETIMEDOUT') {
        this.state = 'disconnected';
      }
    });

    bot.on('login', () => {
      this.callbacks.onLog('info', 'Bot logged in successfully');
    });

    bot.on('end', (reason) => {
      this.callbacks.onLog('info', `Bot disconnected: ${this.formatError(reason)}`);

      this.state = 'disconnected';

      if (this.bot === bot) {
        try {
          bot.removeAllListeners();
          this.bot = null;
          this.callbacks.onLog('info', 'Bot instance cleaned up after disconnect');
        } catch (err) {
          this.callbacks.onLog('warn', `Error cleaning up bot on end event: ${this.formatError(err)}`);
        }
      }
    });
  }

  attemptReconnect(): void {
    this.callbacks.onLog('warn', 'Automatic reconnect is disabled; a new user-triggered launch is required');
  }

  async checkConnectionAndReconnect(): Promise<{ connected: boolean; message?: string }> {
    if (this.state === 'connected') return { connected: true };
    if (this.state === 'connecting') return { connected: false, message: 'Bot is connecting. Wait for the current user-started connection.' };
    return { connected: false, message: 'Disconnected. A user-triggered connection is required (--connect); automatic reconnect is disabled.' };
  }

  assertActionAllowed(name: string): void {
    const reads = new Set(['get-position', 'list-inventory', 'find-item', 'find-blocks', 'get-block-info', 'find-entity', 'detect-gamemode', 'read-chat', 'list-recipes', 'get-recipe', 'can-craft']);
    if (!reads.has(name) && this.bot) getInventoryAuthority(this.bot).assertMutationReady();
  }

  cleanup(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.bot) {
      try {
        this.bot.quit('Server shutting down');
      } catch (err) {
        this.callbacks.onLog('warn', `Error during cleanup: ${this.formatError(err)}`);
      }
    }
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
}
