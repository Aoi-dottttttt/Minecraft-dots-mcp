/**
 * Interactive setup CLI: `awesome-mineflayer-mcp setup`.
 *
 * Records a default account so the server can connect autonomously on startup.
 * For Microsoft accounts it runs the device-code flow ONCE here, caching the
 * token under `profilesFolder` so later server startups need no prompt.
 */

import readline from "node:readline";
import { stdin, stdout } from "node:process";
import { createBot } from "mineflayer";
import {
  loadConfig,
  saveConfig,
  configPath,
  defaultProfilesFolder,
  type StoredAccount,
  type StoredConfig,
} from "./account-config.js";

function botOptions(a: StoredAccount): Record<string, unknown> {
  const o: Record<string, unknown> = { host: a.host, port: a.port ?? 25565, username: a.username, auth: a.auth };
  if (a.version) o.version = a.version;
  if (a.profilesFolder) o.profilesFolder = a.profilesFolder;
  return o;
}

function verifyConnection(a: StoredAccount, microsoft: boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (msg: string): void => {
      if (settled) return;
      settled = true;
      stdout.write(msg);
      try {
        bot.quit();
      } catch {
        /* ignore */
      }
      resolve();
    };
    const bot = createBot({
      ...botOptions(a),
      onMsaCode: (data: { user_code?: string; verification_uri?: string; message?: string }) => {
        stdout.write(
          `\n>> Sign in at ${data?.verification_uri ?? "https://microsoft.com/link"} and enter code: ${data?.user_code ?? "?"}\n` +
            `   ${data?.message ?? ""}\n\n`,
        );
      },
    } as never);
    bot.once("login", () => {
      stdout.write("Logged in; waiting to spawn…\n");
    });
    bot.once("spawn", () =>
      finish(microsoft ? "✓ Microsoft auth succeeded and the token is cached.\n" : "✓ Connected and spawned successfully.\n"),
    );
    bot.once("error", (e: Error) =>
      finish(`! Error: ${e?.message ?? String(e)}${microsoft ? " (token may still be cached if you completed sign-in)" : ""}\n`),
    );
    bot.once("kicked", (reason: unknown) => finish(`! Kicked: ${String(reason)}\n`));
    setTimeout(() => finish("! Timed out waiting to spawn (token may still be cached).\n"), microsoft ? 180_000 : 30_000);
  });
}

export async function runSetup(): Promise<void> {
  // Buffer every input line so none are dropped between prompts (this also makes
  // the wizard work with piped/automated input, not just an interactive TTY).
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: false });
  const queued: string[] = [];
  let waiter: ((line: string) => void) | null = null;
  let closed = false;
  rl.on("line", (line) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(line);
    } else {
      queued.push(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w("");
    }
  });
  const nextLine = (): Promise<string> => {
    const buffered = queued.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (closed) return Promise.resolve("");
    return new Promise<string>((resolve) => {
      waiter = resolve;
    });
  };
  const ask = async (q: string, def?: string): Promise<string> => {
    stdout.write(def !== undefined && def !== "" ? `${q} [${def}]: ` : `${q}: `);
    const line = await nextLine();
    return line.trim() || def || "";
  };
  const askYesNo = async (q: string, defYes: boolean): Promise<boolean> => {
    const a = await ask(`${q} (y/n)`, defYes ? "y" : "n");
    return /^y/i.test(a);
  };

  try {
    stdout.write("\nawesome-mineflayer-mcp — setup\n==============================\n");
    const existing = loadConfig();
    const cur = existing.account;

    const host = await ask("Server host", cur?.host ?? "localhost");
    const port = Number.parseInt(await ask("Server port", String(cur?.port ?? 25565)), 10) || 25565;

    let auth = (await ask("Auth mode (offline/microsoft)", cur?.auth ?? "offline")).toLowerCase();
    while (auth !== "offline" && auth !== "microsoft") {
      auth = (await ask("Please type 'offline' or 'microsoft'", "offline")).toLowerCase();
    }
    const microsoft = auth === "microsoft";

    const username = await ask(microsoft ? "Microsoft account email" : "In-game username", cur?.username);
    if (!username) {
      stdout.write("Username is required — aborting without saving.\n");
      return;
    }

    const version = (await ask("Force protocol version (blank = auto-detect)", cur?.version ?? "")) || undefined;
    const autoReconnect = await askYesNo("Auto-reconnect on unexpected disconnect?", cur?.autoReconnect !== false);
    const autoConnect = await askYesNo("Auto-connect this account when the server starts?", existing.autoConnect !== false);

    const profilesFolder = microsoft ? (cur?.profilesFolder ?? defaultProfilesFolder()) : undefined;

    const account: StoredAccount = {
      host,
      port,
      username,
      auth: microsoft ? "microsoft" : "offline",
      autoReconnect,
      ...(version ? { version } : {}),
      ...(profilesFolder ? { profilesFolder } : {}),
    };

    if (microsoft) {
      if (await askYesNo("Authenticate with Microsoft now to cache the token (recommended)?", true)) {
        stdout.write("\nStarting Microsoft device-code sign-in…\n");
        await verifyConnection(account, true);
      } else {
        stdout.write("Skipped — the first auto-connect will prompt for a device code in the server logs.\n");
      }
    } else if (await askYesNo("Test-connect to the server now?", false)) {
      stdout.write("\nTesting connection…\n");
      await verifyConnection(account, false);
    }

    const cfg: StoredConfig = { ...existing, account, autoConnect };
    const saved = saveConfig(cfg);
    stdout.write(`\nSaved configuration to ${saved}\n`);
    stdout.write(
      autoConnect
        ? "The server will auto-connect this account on startup — no connect_bot call needed.\n"
        : "Auto-connect is OFF; the agent can call connect_default to connect on demand.\n",
    );
    stdout.write(`Config path can be overridden with AWESOME_MINEFLAYER_MCP_HOME. Current: ${configPath()}\n`);
  } finally {
    rl.close();
  }
}
