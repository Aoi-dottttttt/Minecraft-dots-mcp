import { describe, it, expect } from "vitest";
import { EventBus } from "../src/bot/events.js";

describe("EventBus", () => {
  it("assigns monotonic seq and timestamps", () => {
    const bus = new EventBus(100);
    const a = bus.push("chat", { msg: "hi" });
    const b = bus.push("death");
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(b.type).toBe("death");
    expect(bus.lastSeq).toBe(2);
  });

  it("drains everything then nothing on repeat with nextSince", () => {
    const bus = new EventBus(100);
    bus.push("a");
    bus.push("b");
    bus.push("c");
    const first = bus.drain();
    expect(first.events).toHaveLength(3);
    expect(first.nextSince).toBe(3);
    expect(first.dropped).toBe(false);
    const second = bus.drain({ since: first.nextSince });
    expect(second.events).toHaveLength(0);
    expect(second.nextSince).toBe(3);
  });

  it("filters by type and respects limit", () => {
    const bus = new EventBus(100);
    bus.push("chat");
    bus.push("death");
    bus.push("chat");
    expect(bus.drain({ types: ["chat"] }).events).toHaveLength(2);
    expect(bus.drain({ types: ["death"] }).events).toHaveLength(1);
    expect(bus.drain({ limit: 1 }).events).toHaveLength(1);
    // limit returns the OLDEST unread first (seq 1, "chat")
    expect(bus.drain({ limit: 1 }).events[0]!.type).toBe("chat");
  });

  it("limit paginates forward without dropping events", () => {
    const bus = new EventBus(100);
    bus.push("a"); // seq 1
    bus.push("b"); // seq 2
    bus.push("c"); // seq 3
    // First page: oldest event, cursor rewound to it (NOT to seqCounter).
    const page1 = bus.drain({ limit: 1 });
    expect(page1.events.map((e) => e.type)).toEqual(["a"]);
    expect(page1.nextSince).toBe(1);
    expect(page1.dropped).toBe(false);
    // Second page continues from the cursor — no events skipped.
    const page2 = bus.drain({ since: page1.nextSince, limit: 1 });
    expect(page2.events.map((e) => e.type)).toEqual(["b"]);
    expect(page2.nextSince).toBe(2);
    const page3 = bus.drain({ since: page2.nextSince });
    expect(page3.events.map((e) => e.type)).toEqual(["c"]);
    expect(page3.nextSince).toBe(3);
  });

  it("limit:0 is a no-op that does not skip unread events", () => {
    const bus = new EventBus(100);
    bus.push("a"); // seq 1
    bus.push("b"); // seq 2
    const zero = bus.drain({ limit: 0 });
    expect(zero.events).toHaveLength(0);
    // Re-draining from the returned cursor must still yield everything.
    const all = bus.drain({ since: zero.nextSince });
    expect(all.events.map((e) => e.type)).toEqual(["a", "b"]);
  });

  it("evicts oldest beyond capacity and reports dropped", () => {
    const bus = new EventBus(2);
    bus.push("a"); // seq 1 (evicted)
    bus.push("b"); // seq 2 (evicted)
    bus.push("c"); // seq 3
    bus.push("d"); // seq 4
    const drained = bus.drain();
    expect(drained.events.map((e) => e.type)).toEqual(["c", "d"]);
    // asking for events since seq 1 — but 1 & 2 were dropped
    expect(bus.drain({ since: 1 }).dropped).toBe(true);
  });

  it("notifies push listeners and supports unsubscribe", () => {
    const bus = new EventBus(10);
    const seen: string[] = [];
    const off = bus.onPush((e) => seen.push(e.type));
    bus.push("x");
    off();
    bus.push("y");
    expect(seen).toEqual(["x"]);
  });

  it("listener exceptions never break capture", () => {
    const bus = new EventBus(10);
    bus.onPush(() => {
      throw new Error("boom");
    });
    expect(() => bus.push("ok")).not.toThrow();
    expect(bus.lastSeq).toBe(1);
  });
});
