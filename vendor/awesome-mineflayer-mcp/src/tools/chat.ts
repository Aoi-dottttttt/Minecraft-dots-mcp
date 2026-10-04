/** Chat & communication tools. */

import { z } from "zod";
import type { Registrar } from "./registry.js";
import { ToolError } from "../util/errors.js";
import { CHAT_MIN_INTERVAL_MS, checkCommand } from "../config.js";

// Process-wide spacing of outbound chat/whisper/command sends (anti-spam / kick
// protection). Single bot per process, so a module-level timestamp suffices.
// The next slot is RESERVED synchronously (before awaiting) so concurrent calls
// are spaced into successive slots instead of all firing at once.
let lastSendAt = 0;
async function throttleSend(): Promise<void> {
  if (CHAT_MIN_INTERVAL_MS <= 0) return;
  const now = Date.now();
  const at = Math.max(now, lastSendAt + CHAT_MIN_INTERVAL_MS);
  lastSendAt = at;
  const wait = at - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export function registerChat(reg: Registrar): void {
  reg({
    name: "chat",
    group: "chat",
    description:
      "Send a public chat message to the server. To run a slash command use `run_command` instead.",
    inputSchema: {
      message: z.string().describe("The chat message to send"),
    },
    annotations: { title: "Send chat message" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      await throttleSend();
      bot.chat(args.message);
      return { ok: true };
    },
  });

  reg({
    name: "whisper",
    group: "chat",
    description: "Send a private message (whisper) to a specific player.",
    inputSchema: {
      username: z.string().describe("Target player's in-game name"),
      message: z.string().describe("The private message to send"),
    },
    annotations: { title: "Whisper to player" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      await throttleSend();
      bot.whisper(args.username, args.message);
      return { ok: true };
    },
  });

  reg({
    name: "run_command",
    group: "chat",
    description:
      "Run a server slash command. A leading `/` is added automatically if omitted. Some administrative commands (op, ban, stop, …) may be blocked by the server's command policy (see MCP_COMMAND_DENY / MCP_COMMAND_ALLOW).",
    inputSchema: {
      command: z.string().describe('The command to run, e.g. "tp @s 0 64 0" or "/time set day"'),
    },
    annotations: { title: "Run command" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const c = args.command.startsWith("/") ? args.command : "/" + args.command;
      const verdict = checkCommand(c);
      if (!verdict.allowed) {
        throw new ToolError("FORBIDDEN", verdict.reason ?? "Command blocked by the command policy.");
      }
      await throttleSend();
      bot.chat(c);
      return { ok: true, sent: c };
    },
  });

  reg({
    name: "tab_complete",
    group: "chat",
    description:
      "Ask the server for tab-completion suggestions for the given partial text (e.g. command arguments or player names).",
    inputSchema: {
      text: z.string().describe("Partial text to complete"),
      assumeCommand: z
        .boolean()
        .optional()
        .describe("Treat the text as a command even without a leading slash (default false)"),
      sendBlockInSight: z
        .boolean()
        .optional()
        .describe("Send the block currently in the bot's line of sight (default false)"),
      timeout: z.number().int().optional().describe("Max ms to wait for the response"),
    },
    annotations: { readOnlyHint: true, title: "Tab complete" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const res = await bot.tabComplete(
        args.text,
        args.assumeCommand ?? false,
        args.sendBlockInSight ?? false,
        args.timeout,
      );
      const matches = Array.isArray(res)
        ? res.map((m: any) => (typeof m === "string" ? m : (m?.match ?? m)))
        : res;
      return { matches };
    },
  });

  reg({
    name: "register_chat_pattern",
    group: "chat",
    description:
      "Register a named chat pattern (regex). When a matching chat line arrives, it is emitted as a `chat:<name>` event (drain with get_events). Pass an array of patterns to register a pattern set under one name.",
    inputSchema: {
      name: z.string().describe("Pattern name; matches arrive as `chat:<name>` events"),
      pattern: z
        .union([z.string(), z.array(z.string())])
        .describe("A regex source string, or an array of them for a pattern set"),
      repeat: z.boolean().optional().describe("Keep matching repeatedly (default behavior)"),
      parse: z.boolean().optional().describe("Parse capture groups into the event payload"),
    },
    annotations: { title: "Register chat pattern" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const options = { repeat: args.repeat ?? false, parse: args.parse ?? false };
      const id = Array.isArray(args.pattern)
        ? bot.addChatPatternSet(
            args.name,
            args.pattern.map((p) => new RegExp(p)),
            options,
          )
        : bot.addChatPattern(args.name, new RegExp(args.pattern), options);
      return { ok: true, id };
    },
  });

  reg({
    name: "remove_chat_pattern",
    group: "chat",
    description: "Remove a previously registered chat pattern by its name or numeric id.",
    inputSchema: {
      nameOrId: z
        .union([z.string(), z.number()])
        .describe("The pattern name or the id returned by register_chat_pattern"),
    },
    annotations: { title: "Remove chat pattern" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      bot.removeChatPattern(args.nameOrId as any);
      return { ok: true };
    },
  });

  reg({
    name: "wait_for_message",
    group: "chat",
    description:
      "Block until a chat message matching one of the given regex patterns arrives, then return it. Times out (TIMEOUT) after `timeout` ms (default 30000).",
    inputSchema: {
      patterns: z
        .array(z.string())
        .min(1)
        .describe("Regex source strings; the first matching incoming message resolves"),
      timeout: z.number().int().optional().describe("Max ms to wait (default 30000)"),
    },
    annotations: { readOnlyHint: true, title: "Wait for message" },
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const timeoutMs = args.timeout ?? 30000;
      const regexes = args.patterns.map((p) => new RegExp(p));
      let timer: NodeJS.Timeout | undefined;
      try {
        const message = await Promise.race([
          // Forward the timeout to awaitMessage's own internal timer (it pops a
          // trailing number arg at runtime, though the .d.ts doesn't type it).
          (bot.awaitMessage as unknown as (...a: Array<string | RegExp | number>) => Promise<string>)(
            ...regexes,
            timeoutMs,
          ),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new ToolError("TIMEOUT", `No matching message within ${timeoutMs}ms`)),
              timeoutMs,
            );
          }),
        ]);
        return { message };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  });
}
