/** Output formatting + truncation helpers shared by every tool. */

import { CHARACTER_LIMIT } from "../config.js";

/** Clamp text to the character limit with a clear, actionable marker. */
export function truncate(text: string, limit = CHARACTER_LIMIT): string {
  if (text.length <= limit) return text;
  const omitted = text.length - limit;
  return (
    text.slice(0, limit) +
    `\n…[truncated ${omitted} of ${text.length} characters — narrow your query, lower a count/limit, or use format:"concise"]`
  );
}

/** Round to a fixed number of decimal places (entity positions are fractional). */
export function round(n: number, dp = 2): number {
  if (!Number.isFinite(n)) return n;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Stringify arbitrary tool output for the text content block. */
export function toStringText(data: unknown): string {
  if (data === undefined) return "ok";
  if (typeof data === "string") return data;
  return JSON.stringify(data, jsonReplacer, 2);
}

/** Drop function/bigint noise that occasionally leaks from game objects. (Cycles are NOT handled here — JSON.stringify still throws on them; safeClone catches that.) */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "function") return undefined;
  if (typeof value === "bigint") return value.toString();
  return value;
}

/**
 * JSON-safe deep clone (drops functions, stringifies bigint). Returns undefined
 * if the value can't be serialized (e.g. a circular reference) — callers use
 * this to populate `structuredContent` without ever risking a serialization
 * throw turning a successful tool call into an error.
 */
export function safeClone(data: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(data, jsonReplacer));
  } catch {
    return undefined;
  }
}
