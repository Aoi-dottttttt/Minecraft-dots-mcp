#!/usr/bin/env node
/**
 * Entry point. Builds the server and serves it over stdio.
 *
 * IMPORTANT: stdout is the MCP protocol channel — all human/debug logging must
 * go to stderr, never stdout.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { SERVER_NAME, SERVER_VERSION, listDisabledGroups } from "./config.js";
import { runSetup } from "./setup.js";
import { resolveDefaultConnect } from "./account-config.js";
import { disposeScreenshot } from "./bot/screenshot.js";

// stdout is the MCP protocol channel. Some dependencies (e.g. prismarine-viewer)
// log via console.log — route those to stderr so they can't corrupt the stream.
console.log = (...args: unknown[]): void => {
  process.stderr.write(args.map(String).join(" ") + "\n");
};
console.info = console.log;
console.debug = console.log;

async function main(): Promise<void> {
  // `awesome-mineflayer-mcp setup` runs the interactive account setup instead
  // of starting the MCP server.
  if (process.argv[2] === "setup") {
    await runSetup();
    return;
  }

  // Last-resort safety net: a stray rejection from a fire-and-forget mineflayer
  // / plugin call must never take down a long-running server. Log to stderr
  // (never stdout — that's the MCP channel) and keep running.
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(
      `[${SERVER_NAME}] unhandledRejection: ${String((reason as Error)?.stack ?? reason)}\n`,
    );
  });
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[${SERVER_NAME}] uncaughtException: ${String(err?.stack ?? err)}\n`);
  });

  const { server, ctx } = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[${SERVER_NAME}] received ${signal}, shutting down…\n`);
    try {
      ctx.manager.shutdown();
    } catch {
      /* ignore */
    }
    // Close the browser/viewer (capped), then give the quit packet a moment and exit.
    void Promise.race([disposeScreenshot(), new Promise((r) => setTimeout(r, 1500))]).finally(() => {
      setTimeout(() => process.exit(0), 200);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const disabled = listDisabledGroups();
  process.stderr.write(
    `[${SERVER_NAME}] v${SERVER_VERSION} ready on stdio` +
      (disabled.length ? ` (disabled groups: ${disabled.join(", ")})` : "") +
      "\n",
  );

  // Autonomous startup: if a default account is configured, connect it now so
  // the agent doesn't have to. Fire-and-forget — failures are logged to stderr
  // and the server stays usable (connect_bot / connect_default remain available).
  const def = resolveDefaultConnect();
  if (def.opts && def.autoConnect) {
    const who = `${def.account?.auth} ${def.account?.username}@${def.account?.host}`;
    process.stderr.write(`[${SERVER_NAME}] auto-connecting default account (${who})…\n`);
    void ctx.manager.connect(def.opts).then(
      () => process.stderr.write(`[${SERVER_NAME}] auto-connect: online\n`),
      (e: unknown) =>
        process.stderr.write(
          `[${SERVER_NAME}] auto-connect failed: ${String((e as Error)?.message ?? e)} — use connect_bot / connect_default\n`,
        ),
    );
  } else if (def.opts) {
    process.stderr.write(`[${SERVER_NAME}] default account configured (auto-connect off); call connect_default.\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`[${SERVER_NAME}] fatal: ${String((err as Error)?.stack ?? err)}\n`);
  process.exit(1);
});
