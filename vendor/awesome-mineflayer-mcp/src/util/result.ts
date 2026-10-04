/** Builders that turn handler return values / errors into MCP tool results. */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toToolError } from "./errors.js";
import { truncate, safeClone } from "./format.js";
import { CHARACTER_LIMIT } from "../config.js";

/** Wrap a successful handler value (string or JSON-serialisable object). */
export function dataResult(data: unknown): CallToolResult {
  if (data === undefined) {
    return { content: [{ type: "text", text: "ok" }] };
  }
  // Serialize ONCE through safeClone (drops functions/bigint; returns undefined
  // on a circular ref) and derive BOTH channels from it, so a non-serialisable
  // value degrades gracefully instead of throwing and becoming an error result.
  const clone = safeClone(data);
  if (clone === undefined) {
    const text = typeof data === "string" ? data : "[result could not be serialized]";
    return { content: [{ type: "text", text: truncate(text) }] };
  }
  const rendered = typeof clone === "string" ? clone : JSON.stringify(clone, null, 2);
  const result: CallToolResult = { content: [{ type: "text", text: truncate(rendered) }] };
  // Mirror the value as machine-readable `structuredContent` for clients that
  // consume it — but ONLY when it fits the same character budget as the text
  // block, so it can't smuggle an untruncated payload past the CHARACTER_LIMIT
  // guardrail. The MCP field must be a JSON object, so arrays/primitives are
  // wrapped under `value`.
  if (rendered.length <= CHARACTER_LIMIT) {
    result.structuredContent =
      clone !== null && typeof clone === "object" && !Array.isArray(clone)
        ? (clone as Record<string, unknown>)
        : { value: clone };
  }
  return result;
}

/**
 * Marker letting a handler return an already-built CallToolResult (e.g. an image)
 * instead of a plain value. The registry passes `.result` straight through.
 */
export class RawToolResult {
  constructor(public readonly result: CallToolResult) {}
}

/** Build an image tool result (base64 PNG/JPEG, etc.), with optional alt text. */
export function imageResult(base64: string, mimeType: string, altText?: string): RawToolResult {
  const content: CallToolResult["content"] = [];
  if (altText) content.push({ type: "text", text: truncate(altText) });
  content.push({ type: "image", data: base64, mimeType });
  return new RawToolResult({ content });
}

/** Wrap a thrown error into an `isError` result with a stable code + guidance. */
export function errorResult(e: unknown): CallToolResult {
  const { code, message, suggestions } = toToolError(e);
  let text = `Error [${code}]: ${message}`;
  if (suggestions && suggestions.length > 0) {
    text += `\nSuggestions: ${suggestions.join(", ")}`;
  }
  return { content: [{ type: "text", text }], isError: true };
}
