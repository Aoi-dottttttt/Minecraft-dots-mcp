/**
 * Uniform tool registration.
 *
 * Each tool module exports a `register*(reg, ctx)` function that calls `reg(def)`.
 * The registrar:
 *  - skips tools whose group is disabled via MCP_DISABLE_GROUPS,
 *  - passes the (raw Zod shape) inputSchema straight to SDK 1.29's registerTool,
 *  - wraps the handler so its return value becomes a text result and any thrown
 *    error becomes a stable, isError result with guidance.
 */

import type { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isGroupEnabled, READ_ONLY } from "../config.js";
import { dataResult, errorResult, RawToolResult } from "../util/result.js";
import { withTimeout } from "../util/async.js";
import type { ToolContext } from "../context.js";

/** Groups exempt from MCP_READ_ONLY filtering (connection management is not world-mutating). */
const READ_ONLY_EXEMPT_GROUPS = new Set(["lifecycle"]);

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDef<S extends z.ZodRawShape> {
  /** Unique tool name (snake_case). */
  name: string;
  /** Group key for MCP_DISABLE_GROUPS gating. */
  group: string;
  description: string;
  inputSchema?: S;
  annotations?: ToolAnnotations;
  /**
   * Optional safety timeout (ms) for the handler. Use ONLY for tools that await
   * a single server round-trip with no internal timeout/cancellation of their
   * own — NOT for the long-running, self-cancelling actions (goto, fish, smelt,
   * collect_block, …), which manage their own timeouts.
   */
  timeoutMs?: number;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown> | unknown;
}

export type Registrar = <S extends z.ZodRawShape>(def: ToolDef<S>) => void;

export function makeRegistrar(ctx: ToolContext): Registrar {
  return function register<S extends z.ZodRawShape>(def: ToolDef<S>): void {
    if (!isGroupEnabled(def.group)) return;
    // Read-only mode: register only observation tools (+ connection management),
    // so an autonomous bot can be deployed to look-but-not-touch.
    if (READ_ONLY && def.annotations?.readOnlyHint !== true && !READ_ONLY_EXEMPT_GROUPS.has(def.group)) {
      return;
    }

    const config: Record<string, unknown> = { description: def.description };
    if (def.inputSchema) config.inputSchema = def.inputSchema;
    if (def.annotations) config.annotations = def.annotations;

    const callback = async (args: unknown): Promise<CallToolResult> => {
      try {
        const run = def.handler((args ?? {}) as z.infer<z.ZodObject<S>>, ctx);
        const data =
          def.timeoutMs !== undefined ? await withTimeout(run, def.timeoutMs, `Tool '${def.name}'`) : await run;
        // A handler may return an already-built result (e.g. an image).
        return data instanceof RawToolResult ? data.result : dataResult(data);
      } catch (e) {
        return errorResult(e);
      }
    };

    // SDK 1.29's overloaded signature is hard to satisfy generically; the casts
    // are confined to this single well-tested call site.
    (ctx.server.registerTool as unknown as (n: string, c: unknown, cb: unknown) => void)(
      def.name,
      config,
      callback,
    );
  };
}
