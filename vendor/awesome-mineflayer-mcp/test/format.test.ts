import { describe, it, expect } from "vitest";
import { truncate, round, toStringText } from "../src/util/format.js";

describe("format", () => {
  it("leaves short text untouched", () => {
    expect(truncate("hello", 100)).toBe("hello");
  });

  it("truncates long text with a marker", () => {
    const out = truncate("x".repeat(50), 10);
    expect(out.startsWith("x".repeat(10))).toBe(true);
    expect(out).toContain("truncated");
    expect(out).toContain("40 of 50");
  });

  it("rounds to decimal places", () => {
    expect(round(1.23456, 2)).toBe(1.23);
    expect(round(1.5, 0)).toBe(2);
    expect(round(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });

  it("stringifies objects as pretty JSON and passes strings through", () => {
    expect(toStringText("plain")).toBe("plain");
    expect(toStringText(undefined)).toBe("ok");
    expect(toStringText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("drops functions when stringifying", () => {
    const out = toStringText({ a: 1, fn: () => 2 });
    expect(out).toContain('"a": 1');
    expect(out).not.toContain("fn");
  });
});
