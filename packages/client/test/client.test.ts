import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FrameType,
  PROTOCOL_VERSION,
  RECONNECT_MAX_MS,
  WIRE_LOG_SIZE,
  reconnectDelayMs,
  type Snapshot,
} from '@assetpulse/protocol';
import {
  ClientError,
  createClient,
  type AssetPulseClient,
  type WebSocketLike,
} from '../src/index.js';

/** A socket the test drives by hand: `open()`, `deliver()`, and `drop()` play the server. */
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  readonly sent: Record<string, unknown>[] = [];

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  deliver(frame: object): void {
    this.onmessage?.({ data: JSON.stringify({ v: PROTOCOL_VERSION, ts: Date.now(), ...frame }) });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
  sentOfType(type: string): Record<string, unknown>[] {
    return this.sent.filter((f) => f.type === type);
  }
}

const snapshot: Snapshot = {
  assets: [],
  workOrders: [],
  par: { zoneId: 'CLEAN-UTIL', clean: 8, min: 3, max: 8, state: 'OK' },
};
const changed = (seq: number) => ({
  type: FrameType.assetChanged,
  seq,
  assetId: 'IVP-101',
  from: 'CLEAN-UTIL',
  to: 'ICU-301',
  status: 'IN_USE',
});

const latest = () => FakeSocket.instances.at(-1)!;
let client: AssetPulseClient;

function start(random = () => 0.5): AssetPulseClient {
  client = createClient({
    url: 'ws://test/ws',
    hospitalId: 'abcd1234',
    topics: ['floor', 'role:ops'],
    WebSocket: FakeSocket,
    random,
  });
  return client;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
});
afterEach(() => {
  client.close();
  vi.useRealTimers();
});

describe('connect', () => {
  it('carries the hospital id and subscribes before anything else', () => {
    start();
    expect(latest().url).toBe('ws://test/ws?h=abcd1234');
    latest().open();
    expect(latest().sent[0]).toMatchObject({
      type: FrameType.subscribe,
      topics: ['floor', 'role:ops'],
    });
    expect(latest().sentOfType(FrameType.resume)).toEqual([]);
    expect(client.state$.value).toBe('open');
  });
});

describe('backoff', () => {
  it.each([0, 0.996])('reconnects inside the jitter bounds (random=%s)', (r) => {
    start(() => r);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const before = FakeSocket.instances.length;
      latest().drop();
      const delay = reconnectDelayMs(attempt, r);
      const cap = Math.min(RECONNECT_MAX_MS, 500 * 2 ** attempt);
      expect(delay).toBeGreaterThanOrEqual(cap / 2);
      expect(delay).toBeLessThanOrEqual(cap);
      vi.advanceTimersByTime(delay - 1);
      expect(FakeSocket.instances.length).toBe(before);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.instances.length).toBe(before + 1);
      expect(client.state$.value).toBe('reconnecting');
    }
  });

  it('resets the attempt count after a successful open', () => {
    start(() => 0);
    latest().drop();
    vi.advanceTimersByTime(reconnectDelayMs(0, 0));
    latest().drop();
    vi.advanceTimersByTime(reconnectDelayMs(1, 0));
    latest().open();
    const before = FakeSocket.instances.length;
    latest().drop();
    vi.advanceTimersByTime(reconnectDelayMs(0, 0));
    expect(FakeSocket.instances.length).toBe(before + 1);
    expect(client.stats.reconnects).toBe(1);
  });
});

describe('resume', () => {
  it('asks for everything after the last applied seq, after re-subscribing', () => {
    start();
    latest().open();
    latest().deliver({ type: FrameType.hello, worldId: 'abcd1234', seq: 3, snapshot });
    latest().deliver(changed(4));
    latest().deliver(changed(5));
    latest().drop();
    vi.advanceTimersByTime(RECONNECT_MAX_MS);
    // The new hello's seq is ahead of us, but the missed events must still be replayed.
    latest().deliver({ type: FrameType.hello, worldId: 'abcd1234', seq: 9, snapshot });
    latest().open();
    const types = latest().sent.map((f) => f.type);
    expect(types.slice(0, 2)).toEqual([FrameType.subscribe, FrameType.resume]);
    expect(latest().sent[1]).toMatchObject({ lastSeq: 5 });
  });

  it('drops replayed events it already applied', () => {
    start();
    latest().open();
    const seen: number[] = [];
    client.on(FrameType.assetChanged, (f) => seen.push(f.seq));
    latest().deliver(changed(4));
    latest().deliver(changed(4));
    latest().deliver(changed(5));
    expect(seen).toEqual([4, 5]);
  });

  it('takes a resync seq even when it goes backwards (world replaced)', () => {
    start();
    latest().open();
    latest().deliver(changed(40));
    latest().deliver({ type: FrameType.resync, seq: 2, snapshot });
    expect(client.stats.lastSeq).toBe(2);
  });
});

describe('commands', () => {
  it('resolves with the matching ack', async () => {
    start();
    latest().open();
    const done = client.send({ name: 'surge', args: {} });
    const cmd = latest()
      .sentOfType(FrameType.command)
      .find((f) => f.name === 'surge')!;
    latest().deliver({ type: FrameType.ack, cmdId: cmd.cmdId, ok: true });
    await expect(done).resolves.toMatchObject({ ok: true, cmdId: cmd.cmdId });
  });

  it('rejects pending commands with DISCONNECTED on close', async () => {
    start();
    latest().open();
    const done = client.send({ name: 'reset', args: {} });
    latest().drop();
    await expect(done).rejects.toEqual(new ClientError('DISCONNECTED'));
  });

  it('rejects immediately while not open', async () => {
    start();
    await expect(client.send({ name: 'surge', args: {} })).rejects.toBeInstanceOf(ClientError);
  });
});

describe('kill', () => {
  it('closes the socket and blocks reconnect for the given time', async () => {
    start(() => 0);
    latest().open();
    const done = client.send({ name: 'surge', args: {} });
    const killed = latest();
    client.kill(10_000);
    expect(killed.readyState).toBe(3);
    expect(client.state$.value).toBe('killed');
    await expect(done).rejects.toEqual(new ClientError('DISCONNECTED'));
    vi.advanceTimersByTime(9_999);
    expect(FakeSocket.instances.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances.length).toBe(2);
    expect(client.state$.value).toBe('reconnecting');
  });
});

describe('stats', () => {
  it('measures rtt from a real ping ack round trip', () => {
    start();
    latest().open();
    const ping = latest()
      .sentOfType(FrameType.command)
      .find((f) => f.name === 'ping')!;
    vi.advanceTimersByTime(37);
    latest().deliver({ type: FrameType.ack, cmdId: ping.cmdId, ok: true });
    expect(client.stats.rttMs).toBe(37);
  });

  it('counts inbound frames and keeps only the last WIRE_LOG_SIZE raw frames', () => {
    start();
    latest().open();
    for (let seq = 1; seq <= WIRE_LOG_SIZE + 10; seq += 1) latest().deliver(changed(seq));
    expect(client.stats.framesIn).toBe(WIRE_LOG_SIZE + 10);
    expect(client.stats.lastFrameRaw).toHaveLength(WIRE_LOG_SIZE);
    const last = client.stats.lastFrameRaw.at(-1)!;
    expect(last.dir).toBe('in');
    expect(JSON.parse(last.raw)).toMatchObject({ seq: WIRE_LOG_SIZE + 10 });
  });
});
