import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BACKPRESSURE_BYTES,
  FrameType,
  type SequencedEvent,
  type ServerFrame,
  type Topic,
} from '@assetpulse/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistorySink } from '../src/adapters/history-sink.js';
import { ServiceNowMock } from '../src/adapters/servicenow-mock.js';
import { startApp, type App, type AppOptions } from '../src/app.js';
import { startHeartbeat } from '../src/hub/heartbeat.js';
import { delay, TestClient } from './support/test-client.js';

const H1 = 'hosp0001';
/** A tick so slow the simulator never fires: only commands change the world. */
const FROZEN_TICK_MS = 3_600_000;

const surge = { name: 'surge', args: {} } as const;
const reset = { name: 'reset', args: {} } as const;

let historyDir: string;
const apps: App[] = [];
const clients: TestClient[] = [];

async function start(options: AppOptions = {}): Promise<App> {
  const app = await startApp({
    sink: new HistorySink(historyDir),
    serviceNow: new ServiceNowMock(() => {}),
    ...options,
  });
  apps.push(app);
  return app;
}

async function connect(app: App, topics?: Topic[]): Promise<TestClient> {
  const client = await TestClient.connect(app.port, H1, topics);
  clients.push(client);
  return client;
}

const isEvent = (f: ServerFrame): f is SequencedEvent =>
  f.type === FrameType.assetChanged ||
  f.type === FrameType.parAlert ||
  f.type === FrameType.workOrder;

/** Waits until `client` holds `count` events after index `from`. */
async function eventsAfter(client: TestClient, from: number, count: number) {
  await client.next(
    FrameType.assetChanged,
    () => client.frames.slice(from).filter(isEvent).length >= count,
    from,
  );
  return client.frames.slice(from).filter(isEvent);
}

beforeEach(async () => {
  historyDir = await mkdtemp(path.join(tmpdir(), 'assetpulse-delivery-'));
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const a of apps.splice(0)) await a.close();
  await rm(historyDir, { recursive: true, force: true });
});

describe('position coalescing', () => {
  it('sends at most 5 positions frames per second, each with the latest position per asset', async () => {
    const app = await start();
    const floor = await connect(app, ['floor']);
    const from = floor.frames.length;
    await delay(2_000);

    const frames = floor.frames.slice(from).filter((f) => f.type === FrameType.positions);
    expect(frames.length).toBeGreaterThanOrEqual(6);
    expect(frames.length).toBeLessThanOrEqual(10);
    for (const frame of frames) {
      const ids = frame.batch.map((p) => p.assetId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(frame).not.toHaveProperty('seq');
    }
  });
});

describe('backpressure', () => {
  it('skips position flushes for a backed-up client but still delivers every event', async () => {
    const app = await start();
    const ops = await connect(app, ['floor']);
    // A subscriber whose send queue never drains — exactly what a stalled socket looks like
    // to the hub. (Pausing a real stream would need MBs of kernel buffer filled first.)
    const slow = {
      topics: new Set<Topic>(['floor']),
      bufferedAmount: BACKPRESSURE_BYTES + 1,
      received: [] as ServerFrame[],
      send(frame: ServerFrame) {
        this.received.push(frame);
      },
    };
    const hub = app.registry.get(H1)!;
    hub.attach(slow);
    const afterSeq = hub.log.seq;

    await ops.command('surge', surge);
    await ops.command('reset', reset);
    await delay(600);

    // Compare by seq: frames broadcast before the attach may still be in flight to `ops`.
    const opsEvents = ops.frames.filter(isEvent).filter((e) => e.seq > afterSeq);
    const slowEvents = slow.received.filter(isEvent);
    expect(opsEvents.length).toBeGreaterThanOrEqual(8);
    expect(slowEvents.slice(0, opsEvents.length)).toEqual(opsEvents);
    expect(slow.received.filter((f) => f.type === FrameType.positions)).toEqual([]);

    const health = (await (await fetch(`http://127.0.0.1:${app.port}/healthz`)).json()) as {
      positionSkips: number;
    };
    expect(health.positionSkips).toBeGreaterThan(0);
  });
});

describe('resume', () => {
  it('replays exactly the missed events, in order', async () => {
    const app = await start({ tickMs: FROZEN_TICK_MS });
    const observer = await connect(app, ['floor']);
    const dropped = await connect(app, ['floor']);
    const lastSeq = dropped.of(FrameType.hello)[0]!.seq;
    dropped.close();

    const from = observer.frames.length;
    for (const command of [surge, reset, surge, reset, surge]) {
      await observer.command('gen', command);
    }
    const missed = await eventsAfter(observer, from, 20);
    expect(missed).toHaveLength(20);

    const resumed = await connect(app, ['floor']);
    const replayFrom = resumed.frames.length;
    await resumed.send({ type: FrameType.resume, lastSeq });
    const replayed = await eventsAfter(resumed, replayFrom, 20);

    expect(replayed).toEqual(missed);
    expect(replayed.map((e) => e.seq)).toEqual(missed.map((_, i) => lastSeq + 1 + i));
  });

  it('filters the replay by the resuming client’s topics', async () => {
    const app = await start({ tickMs: FROZEN_TICK_MS });
    const ops = await connect(app, ['floor']);
    await ops.command('gen', surge);

    const tech = await connect(app, ['role:tech']);
    const from = tech.frames.length;
    await tech.send({ type: FrameType.resume, lastSeq: 0 });
    await tech.command('sync', surge); // its ack is a barrier: the replay was sent before it
    expect(tech.frames.slice(from).filter(isEvent)).toEqual([]);
  });

  it('sends a resync snapshot when the missed events were evicted', async () => {
    const app = await start({ tickMs: FROZEN_TICK_MS, eventLogSize: 5 });
    const ops = await connect(app, ['floor']);
    await ops.command('gen', surge);
    await ops.command('gen', reset);

    const from = ops.frames.length;
    await ops.send({ type: FrameType.resume, lastSeq: 1 });
    const resync = await ops.next(FrameType.resync, () => true, from);
    expect(resync.seq).toBe(8);
    expect(resync.snapshot.par.clean).toBe(8);
    expect(ops.frames.slice(from).filter(isEvent)).toEqual([]);
  });
});

describe('heartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  class FakeSocket extends EventEmitter {
    pings = 0;
    terminated = false;
    constructor(private readonly answers: boolean) {
      super();
    }
    ping() {
      this.pings++;
      if (this.answers) queueMicrotask(() => this.emit('pong'));
    }
    terminate() {
      this.terminated = true;
    }
  }

  it('terminates a socket that missed a pong, and keeps one that answers', async () => {
    const live = new FakeSocket(true);
    const dead = new FakeSocket(false);
    const stop = startHeartbeat(() => [live, dead], 15_000);

    await vi.advanceTimersByTimeAsync(15_000);
    expect([live.pings, dead.pings]).toEqual([1, 1]);
    expect(dead.terminated).toBe(false);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(dead.terminated).toBe(true);
    expect(live.terminated).toBe(false);
    expect(live.pings).toBe(2);

    stop();
  });
});
