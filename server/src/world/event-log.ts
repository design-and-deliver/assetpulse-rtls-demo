import { EVENT_LOG_SIZE, PROTOCOL_VERSION, type SequencedEvent } from '@assetpulse/protocol';
import type { WorldEvent } from './world.js';

export interface EventLogOptions {
  /** Events kept for `since`. Older ones are evicted and force a resync. */
  capacity?: number;
  /** Clock for the envelope `ts`. Injected so tests stay deterministic. */
  now?: () => number;
}

/**
 * The durable half of the two streams: a fixed-size ring of sequenced events per world.
 * `seq` starts at 1 and is contiguous, so event `s` always lives in slot `(s - 1) % capacity`.
 */
export class EventLog {
  private readonly slots: SequencedEvent[] = [];
  private readonly capacity: number;
  private readonly now: () => number;
  private lastSeq = 0;

  constructor({ capacity = EVENT_LOG_SIZE, now = Date.now }: EventLogOptions = {}) {
    if (capacity < 1) throw new RangeError('EventLog capacity must be at least 1');
    this.capacity = capacity;
    this.now = now;
  }

  /** The seq of the newest event, or 0 before the first append. */
  get seq(): number {
    return this.lastSeq;
  }

  /** Stamps the envelope and the next `seq`, stores the event, and returns the wire-ready frame. */
  append(event: WorldEvent): SequencedEvent {
    this.lastSeq += 1;
    const stamped: SequencedEvent = {
      ...event,
      v: PROTOCOL_VERSION,
      ts: this.now(),
      seq: this.lastSeq,
    };
    this.slots[(this.lastSeq - 1) % this.capacity] = stamped;
    return stamped;
  }

  /**
   * Every event after `lastSeq`, oldest first. Returns `null` when the gap cannot be replayed —
   * `lastSeq` was evicted, or is ahead of this log (the server restarted) — so the caller
   * sends a `resync` instead.
   */
  since(lastSeq: number): SequencedEvent[] | null {
    const oldestKept = Math.max(1, this.lastSeq - this.capacity + 1);
    if (lastSeq > this.lastSeq || lastSeq < oldestKept - 1) return null;
    const events: SequencedEvent[] = [];
    for (let s = lastSeq + 1; s <= this.lastSeq; s++) {
      events.push(this.slots[(s - 1) % this.capacity]!);
    }
    return events;
  }
}
