import { FrameType, PROTOCOL_VERSION } from '@assetpulse/protocol';
import { describe, expect, it } from 'vitest';
import { CommandCache, type Ack } from '../src/world/command-cache.js';
import { EventLog } from '../src/world/event-log.js';
import type { WorldEvent } from '../src/world/world.js';

const T0 = 1_760_000_000_000;

function moved(assetId: string): WorldEvent {
  return {
    type: FrameType.assetChanged,
    assetId,
    from: 'CLEAN-UTIL',
    to: 'ICU-301',
    status: 'IN_USE',
  };
}

/** A log of `capacity` holding events 1..n. */
function filled(n: number, capacity = 10): EventLog {
  const log = new EventLog({ capacity, now: () => T0 });
  for (let i = 1; i <= n; i++) log.append(moved(`P${i}`));
  return log;
}

const seqs = (log: EventLog, lastSeq: number) => log.since(lastSeq)?.map((e) => e.seq) ?? null;

describe('EventLog', () => {
  it('stamps the envelope and a monotonic seq starting at 1', () => {
    const log = new EventLog({ now: () => T0 });
    expect(log.seq).toBe(0);
    const stamped = [1, 2, 3].map((i) => log.append(moved(`P${i}`)));
    expect(stamped.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(stamped[0]).toMatchObject({ v: PROTOCOL_VERSION, ts: T0, assetId: 'P1' });
    expect(log.seq).toBe(3);
  });

  it('since(0) replays everything while nothing is evicted', () => {
    expect(seqs(filled(4), 0)).toEqual([1, 2, 3, 4]);
    expect(seqs(filled(0), 0)).toEqual([]);
  });

  it('since(latest) is empty, not null', () => {
    expect(seqs(filled(4), 4)).toEqual([]);
  });

  it('replays from exactly the oldest kept edge, and resyncs one before it', () => {
    const log = filled(25); // capacity 10 keeps 16..25
    expect(seqs(log, 15)).toEqual([16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
    expect(log.since(14)).toBeNull();
    expect(log.since(0)).toBeNull();
  });

  it('resyncs a client that is ahead of the log (server restarted)', () => {
    expect(filled(3).since(7)).toBeNull();
  });

  it('keeps order across the ring wrap', () => {
    expect(seqs(filled(13), 8)).toEqual([9, 10, 11, 12, 13]);
  });

  it('resyncs anything older than a barrier, and replays from it onward', () => {
    const log = filled(4);
    log.barrier();
    log.append(moved('P5'));
    expect(log.since(3)).toBeNull();
    expect(seqs(log, 4)).toEqual([5]);
  });
});

describe('CommandCache', () => {
  const ack = (cmdId: string): Ack => ({
    v: PROTOCOL_VERSION,
    ts: T0,
    type: FrameType.ack,
    cmdId,
    ok: true,
  });

  it('returns the original ack for a repeated cmdId', () => {
    const cache = new CommandCache(3);
    cache.set('a', ack('a'));
    expect(cache.get('a')).toEqual(ack('a'));
    expect(cache.get('zzz')).toBeUndefined();
  });

  it('evicts the least recently used, where a get counts as a use', () => {
    const cache = new CommandCache(3);
    for (const id of ['a', 'b', 'c']) cache.set(id, ack(id));
    cache.get('a'); // order now b, c, a
    cache.set('d', ack('d')); // evicts b
    expect(cache.get('b')).toBeUndefined();
    cache.set('e', ack('e')); // evicts c
    expect(cache.get('c')).toBeUndefined();
    expect(['a', 'd', 'e'].map((id) => cache.get(id)?.cmdId)).toEqual(['a', 'd', 'e']);
    expect(cache.size).toBe(3);
  });

  it('re-setting a key refreshes it without growing', () => {
    const cache = new CommandCache(2);
    cache.set('a', ack('a'));
    cache.set('b', ack('b'));
    cache.set('a', ack('a'));
    cache.set('c', ack('c')); // evicts b, not a
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
  });
});
