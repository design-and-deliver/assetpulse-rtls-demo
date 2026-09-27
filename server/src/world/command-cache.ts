import { COMMAND_CACHE_SIZE, type ServerFrame } from '@assetpulse/protocol';

export type Ack = Extract<ServerFrame, { type: 'ack' }>;

/**
 * LRU of `cmdId → ack`, so a client that retries a command after a dropped ack gets the
 * original ack back instead of applying the command twice. A `Map` keeps insertion order,
 * so its first key is always the least recently used.
 */
export class CommandCache {
  private readonly entries = new Map<string, Ack>();

  constructor(private readonly capacity = COMMAND_CACHE_SIZE) {
    if (capacity < 1) throw new RangeError('CommandCache capacity must be at least 1');
  }

  get size(): number {
    return this.entries.size;
  }

  /** The cached ack, refreshed to most-recently-used; undefined if unseen or evicted. */
  get(cmdId: string): Ack | undefined {
    const ack = this.entries.get(cmdId);
    if (ack === undefined) return undefined;
    this.entries.delete(cmdId);
    this.entries.set(cmdId, ack);
    return ack;
  }

  set(cmdId: string, ack: Ack): void {
    this.entries.delete(cmdId);
    this.entries.set(cmdId, ack);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value!;
      this.entries.delete(oldest);
    }
  }
}
