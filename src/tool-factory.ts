// Modified for 2.1.0-dot.1 release (2026-10-03). See RELEASE.md.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, ZodError, ZodRawShape, ZodType } from "zod";
import { BotConnection } from './bot-connection.js';

type McpResponse = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
};

export class ToolFactory {
  // Hold one lane until the executor has actually settled. A timeout must not
  // release this lane while an underlying click or movement can still run.
  private actionTail: Promise<void> = Promise.resolve();

  /** One lane shared by foreground MCP calls and explicitly enabled survival jobs. */
  runInActionLane<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.actionTail.then(operation, operation);
    this.actionTail = result.then(() => undefined, () => undefined);
    return result;
  }

  constructor(
    private server: McpServer,
    private connection: BotConnection
  ) {}

  registerTool(
    name: string,
    description: string,
    schema: Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: (args: any) => Promise<McpResponse>
  ): void {
    this.server.tool(name, description, schema, (args: unknown): Promise<McpResponse> => {
      const execute = async (): Promise<McpResponse> => {
        try {
          const parsedArgs = this.shouldValidateSchema(schema)
            ? this.parseArgs(schema as ZodRawShape, args)
            : args;
          const connectionCheck = await this.connection.checkConnectionAndReconnect();
          if (!connectionCheck.connected) {
            return { content: [{ type: 'text', text: connectionCheck.message ?? 'Bot is not connected' }], isError: true };
          }
          const guardedConnection = this.connection as BotConnection & { assertActionAllowed?: (name: string) => void };
          guardedConnection.assertActionAllowed?.(name);
          return await executor(parsedArgs);
        } catch (error) {
          return this.createErrorResponse(error instanceof Error ? error : String(error));
        }
      };
      return this.runInActionLane(execute);
    });
  }

  createResponse(text: string): McpResponse {
    return {
      content: [{ type: "text", text }]
    };
  }

  createErrorResponse(error: Error | string): McpResponse {
    const errorMessage = error instanceof Error ? error.message : error;
    return {
      content: [{ type: "text", text: `Failed: ${errorMessage}` }],
      isError: true
    };
  }

  private shouldValidateSchema(schema: Record<string, unknown>): boolean {
    const values = Object.values(schema);
    if (values.length === 0) {
      return true;
    }

    return values.every((value) => value instanceof ZodType);
  }

  private parseArgs(schema: ZodRawShape, args: unknown): unknown {
    try {
      return z.object(schema).passthrough().parse(args ?? {});
    } catch (error) {
      if (error instanceof ZodError) {
        throw new Error(this.formatZodError(error));
      }
      throw error;
    }
  }

  private formatZodError(error: ZodError): string {
    const details = error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return `${path}${issue.message}`;
      })
      .join('; ');

    return `Invalid tool arguments: ${details}`;
  }
}
