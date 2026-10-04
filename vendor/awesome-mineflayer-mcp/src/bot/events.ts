/**
 * In-memory event ring buffer.
 *
 * Discrete, agent-actionable game events are pushed here and drained via the
 * `get_events` tool. Push listeners (registered by the resource layer) fan each
 * event out to MCP logging / resource-update notifications, throttled elsewhere.
 */

import { EVENT_BUFFER_SIZE } from "../config.js";

export interface GameEvent {
  /** Monotonic sequence number (1-based). */
  seq: number;
  /** Unix epoch ms when captured. */
  ts: number;
  /** Event type, e.g. "chat", "death", "goal_reached". */
  type: string;
  /** Serialisable payload (already reduced to plain JSON). */
  data: unknown;
}

export type EventPushListener = (event: GameEvent) => void;

export interface DrainOptions {
  /** Return only events with seq strictly greater than this. */
  since?: number;
  /** Restrict to these event types. */
  types?: string[];
  /**
   * Return at most this many events, OLDEST matching first. When more than
   * `limit` are pending, the surplus is NOT dropped: `nextSince` is set to the
   * last event actually returned so the remainder is delivered (in order,
   * without loss) on the next call.
   */
  limit?: number;
}

export interface DrainResult {
  events: GameEvent[];
  /** Pass as `since` on the next call to continue without gaps. */
  nextSince: number;
  /** True if `since` pointed before the oldest retained event (some were lost). */
  dropped: boolean;
}

export class EventBus {
  private buffer: GameEvent[] = [];
  private seqCounter = 0;
  private readonly listeners = new Set<EventPushListener>();
  private readonly capacity: number;

  constructor(capacity = EVENT_BUFFER_SIZE) {
    this.capacity = Math.max(1, capacity);
  }

  /** Append an event and notify push listeners. Never throws. */
  push(type: string, data: unknown = null): GameEvent {
    const event: GameEvent = { seq: ++this.seqCounter, ts: Date.now(), type, data };
    this.buffer.push(event);
    const overflow = this.buffer.length - this.capacity;
    if (overflow > 0) this.buffer.splice(0, overflow);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A misbehaving listener must never break event capture.
      }
    }
    return event;
  }

  /** Drain events after `since`, optionally filtered by type and capped. */
  drain(opts: DrainOptions = {}): DrainResult {
    const { since, types, limit } = opts;
    const oldestSeq = this.buffer.length > 0 ? this.buffer[0]!.seq : this.seqCounter;
    const dropped = since !== undefined && since + 1 < oldestSeq;

    let out = since !== undefined ? this.buffer.filter((e) => e.seq > since) : this.buffer.slice();
    if (types && types.length > 0) {
      const set = new Set(types);
      out = out.filter((e) => set.has(e.type));
    }
    // By default the caller has now seen everything up to the latest seq.
    let nextSince = this.seqCounter;
    if (limit !== undefined && limit >= 0 && out.length > limit) {
      // Forward-paginate: hand back the OLDEST `limit` events and rewind the
      // cursor to the last one returned, so the remainder is delivered on the
      // next call instead of being silently skipped (which the previous
      // "keep newest N, advance to seqCounter" behaviour did).
      out = out.slice(0, limit);
      // Advance the cursor only to the last event actually returned. When limit
      // is 0 (out becomes empty), DON'T jump to seqCounter — that would skip all
      // unread events; rewind to just before the oldest retained event instead.
      nextSince = out.length > 0 ? out[out.length - 1]!.seq : (since ?? oldestSeq - 1);
    }
    return { events: out, nextSince, dropped };
  }

  /** Most recent `n` events (used to seed the events resource). */
  recent(n: number): GameEvent[] {
    return this.buffer.slice(Math.max(0, this.buffer.length - n));
  }

  get lastSeq(): number {
    return this.seqCounter;
  }

  /** Register a push listener; returns an unsubscribe function. */
  onPush(listener: EventPushListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear(): void {
    this.buffer = [];
  }
}
