/**
 * Advanced/unsafe raw protocol access — direct read/write of low-level Minecraft
 * packets via bot._client. OFF by default; only registered when MCP_ENABLE_RAW
 * is set. This is an escape hatch for protocol features the high-level API
 * doesn't wrap; it bypasses all other guardrails, so use with care.
 */

import { z } from "zod";
import type { Registrar } from "./registry.js";
import type { ToolContext } from "../context.js";
import { ToolError } from "../util/errors.js";
import { RAW_ENABLED } from "../config.js";

interface RawClient {
  write?: (n: string, p: unknown) => void;
  on?: (n: string, cb: (d: unknown) => void) => void;
  removeListener?: (n: string, cb: (d: unknown) => void) => void;
}

interface Sub {
  client: RawClient | null;
  handler: (d: unknown) => void;
}

// Per-context subscription registry (single bot per process).
const SUBS = new WeakMap<object, Map<string, Sub>>();
function rawSubs(ctx: object): Map<string, Sub> {
  let m = SUBS.get(ctx);
  if (!m) {
    m = new Map();
    SUBS.set(ctx, m);
  }
  return m;
}

function rawClient(ctx: ToolContext): RawClient | null {
  const bot = ctx.manager.botOrNull();
  return (bot as unknown as { _client?: RawClient } | null)?._client ?? null;
}

export function registerRaw(reg: Registrar, ctx: ToolContext): void {
  if (!RAW_ENABLED) return; // group disabled unless explicitly enabled

  // Re-bind all tracked subscriptions whenever the bot comes online — a reconnect
  // replaces bot._client, orphaning the old listeners, so without this a
  // subscription would silently stop delivering after the first reconnect.
  ctx.events.onPush((e) => {
    if (e.type !== "status" || (e.data as { status?: string } | null)?.status !== "online") return;
    const client = rawClient(ctx);
    if (!client?.on) return;
    for (const [name, sub] of rawSubs(ctx)) {
      const handler = (data: unknown): void => {
        ctx.events.push(`packet:${name}`, data);
      };
      try {
        client.on(name, handler);
        sub.client = client;
        sub.handler = handler;
      } catch {
        /* best-effort */
      }
    }
  });

  reg({
    name: "send_packet",
    group: "raw",
    description:
      "ADVANCED/UNSAFE. Write a raw protocol packet via bot._client.write(name, params). Bypasses all guardrails. Only available when MCP_ENABLE_RAW is set.",
    inputSchema: {
      name: z.string().describe('Packet name (server-bound), e.g. "chat", "use_entity"'),
      params: z.record(z.string(), z.unknown()).optional().describe("Packet params object"),
    },
    annotations: { title: "Send raw packet", destructiveHint: true },
    handler: (args, c) => {
      c.manager.requireBot();
      const client = rawClient(c);
      if (!client?.write) throw new ToolError("UNSUPPORTED", "Raw client is unavailable.");
      client.write(args.name, args.params ?? {});
      return { ok: true, sent: args.name };
    },
  });

  reg({
    name: "subscribe_packet",
    group: "raw",
    description:
      "ADVANCED. Subscribe to a client-bound packet by name; each one is pushed into the event buffer as a `packet:<name>` event (drain with get_events). Idempotent per name, and re-applied automatically across reconnects. Only when MCP_ENABLE_RAW is set.",
    inputSchema: { name: z.string().describe("Packet name to subscribe to") },
    annotations: { title: "Subscribe to raw packet" },
    handler: (args, c) => {
      c.manager.requireBot();
      const client = rawClient(c);
      if (!client?.on) throw new ToolError("UNSUPPORTED", "Raw client is unavailable.");
      const subs = rawSubs(c);
      const existing = subs.get(args.name);
      if (existing && existing.client === client) {
        return { ok: true, alreadySubscribed: true, packet: args.name };
      }
      // Stale entry bound to a previous (dead) client — drop it before re-binding.
      if (existing?.client?.removeListener) {
        try {
          existing.client.removeListener(args.name, existing.handler);
        } catch {
          /* ignore */
        }
      }
      const handler = (data: unknown): void => {
        c.events.push(`packet:${args.name}`, data);
      };
      client.on(args.name, handler);
      subs.set(args.name, { client, handler });
      return { ok: true, packet: args.name };
    },
  });

  reg({
    name: "unsubscribe_packet",
    group: "raw",
    description: "Stop a packet subscription started by subscribe_packet. Only when MCP_ENABLE_RAW is set.",
    inputSchema: { name: z.string().describe("Packet name to unsubscribe") },
    annotations: { title: "Unsubscribe raw packet" },
    handler: (args, c) => {
      const subs = rawSubs(c);
      const entry = subs.get(args.name);
      if (entry?.client?.removeListener) {
        try {
          entry.client.removeListener(args.name, entry.handler);
        } catch {
          /* ignore */
        }
      }
      subs.delete(args.name);
      return { ok: true, unsubscribed: !!entry };
    },
  });

  reg({
    name: "list_packet_subscriptions",
    group: "raw",
    description: "List the packet names currently subscribed via subscribe_packet.",
    inputSchema: {},
    annotations: { readOnlyHint: true, title: "List packet subscriptions" },
    handler: (_args, c) => {
      return { subscriptions: [...rawSubs(c).keys()] };
    },
  });
}
