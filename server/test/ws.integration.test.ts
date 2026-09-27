import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CLOSE_BAD_FRAME,
  CLOSE_CAPACITY,
  FrameType,
  PROTOCOL_VERSION,
  parseServerFrame,
  type ClientFrame,
  type ServerFrame,
  type Topic,
} from '@assetpulse/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { HistorySink } from '../src/adapters/history-sink.js';
import { ServiceNowMock } from '../src/adapters/servicenow-mock.js';
import { startApp, type App } from '../src/app.js';
import { WorldRegistry } from '../src/hub/world-registry.js';

const H1 = 'hosp0001';
const H2 = 'hosp0002';
const WAIT_MS = 3_000;
/** Shared by every client: the command cache is per world, so cmdIds must be world-unique. */
let cmdCounter = 0;

type Frame<T extends ServerFrame['type']> = Extract<ServerFrame, { type: T }>;

/** A real `ws` client that records every parsed frame and can wait for the next match. */
class TestClient {
  readonly frames: ServerFrame[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private readonly ws: WebSocket;
  private readonly opened: Promise<void>;

  constructor(port: number, query: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
    this.opened = new Promise((resolve) => this.ws.once('open', () => resolve()));
    this.closed = new Promise((resolve) =>
      this.ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
    );
    this.ws.on('message', (data) => {
      const parsed = parseServerFrame(data.toString());
      if (!parsed.ok) throw new Error(`server sent an invalid frame: ${parsed.error}`);
      this.frames.push(parsed.frame);
    });
  }

  static async connect(port: number, h: string, topics?: Topic[]): Promise<TestClient> {
    const client = new TestClient(port, `?h=${h}`);
    await client.next(FrameType.hello);
    if (topics) await client.subscribe(topics);
    return client;
  }

  /** Resolves with the first frame of `type` (from index `from`) that satisfies `match`. */
  async next<T extends ServerFrame['type']>(
    type: T,
    match: (f: Frame<T>) => boolean = () => true,
    from = 0,
  ): Promise<Frame<T>> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const hit = this.frames
        .slice(from)
        .find((f): f is Frame<T> => f.type === type && match(f as Frame<T>));
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
      await delay(10);
    }
  }

  of<T extends ServerFrame['type']>(type: T): Frame<T>[] {
    return this.frames.filter((f): f is Frame<T> => f.type === type);
  }

  async sendRaw(raw: string): Promise<void> {
    await this.opened;
    this.ws.send(raw);
  }

  async send(frame: Omit<ClientFrame, 'v' | 'ts'>): Promise<void> {
    await this.sendRaw(JSON.stringify({ v: PROTOCOL_VERSION, ts: Date.now(), ...frame }));
  }

  /** Subscribes, then waits one round trip so the server has applied it. */
  async subscribe(topics: Topic[]): Promise<void> {
    await this.send({ type: FrameType.subscribe, topics });
    // A no-op command (NOT_FOUND) as a barrier: its ack means the subscribe was applied.
    await this.command('sync', { name: 'move_asset', args: { assetId: 'none', toZoneId: 'none' } });
  }

  /** Sends a command and resolves with its ack. */
  async command(
    prefix: string,
    command: Pick<Extract<ClientFrame, { type: 'command' }>, 'name' | 'args'>,
    cmdId = `${prefix}-${++cmdCounter}`,
  ): Promise<Frame<'ack'>> {
    const from = this.frames.length;
    await this.send({ type: FrameType.command, cmdId, ...command } as Omit<
      ClientFrame,
      'v' | 'ts'
    >);
    return this.next(FrameType.ack, (a) => a.cmdId === cmdId, from);
  }

  close(): void {
    this.ws.close();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const surge = { name: 'surge', args: {} } as const;

let app: App;
let historyDir: string;
const clients: TestClient[] = [];

async function connect(h: string, topics?: Topic[]): Promise<TestClient> {
  const client = await TestClient.connect(app.port, h, topics);
  clients.push(client);
  return client;
}

/** Two surges empty the clean shelf (8 → 4 → 0); the next tick opens the PAR work order. */
async function breachPar(ops: TestClient): Promise<Frame<'work_order'>> {
  await ops.command('surge', surge);
  await ops.command('surge', surge);
  return ops.next(FrameType.workOrder, (f) => f.order.state === 'open');
}

beforeEach(async () => {
  historyDir = await mkdtemp(path.join(tmpdir(), 'assetpulse-ws-'));
  app = await startApp({
    sink: new HistorySink(historyDir),
    serviceNow: new ServiceNowMock(() => {}),
  });
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await app.close();
  await rm(historyDir, { recursive: true, force: true });
});

describe('ws hub', () => {
  it('greets with a hello snapshot of the initial floor', async () => {
    const client = await connect(H1);
    const hello = client.of(FrameType.hello)[0]!;
    expect(hello.worldId).toBe(H1);
    expect(hello.seq).toBe(0);
    expect(hello.snapshot.assets).toHaveLength(14);
    expect(hello.snapshot.par).toMatchObject({ zoneId: 'CLEAN-UTIL', clean: 8, state: 'OK' });
    expect(hello.snapshot.workOrders).toEqual([]);
  });

  it('routes by topic: a tech gets work orders but no positions until it subscribes to floor', async () => {
    const tech = await connect(H1, ['role:tech']);
    const ops = await connect(H1, ['floor', 'role:ops']);

    const order = await breachPar(ops);
    await tech.next(FrameType.workOrder, (f) => f.order.number === order.order.number);
    await ops.next(FrameType.positions);
    expect(tech.of(FrameType.positions)).toEqual([]);
    expect(tech.of(FrameType.assetChanged)).toEqual([]);
    expect(tech.of(FrameType.parAlert)).toEqual([]);

    await tech.subscribe(['role:tech', 'floor']);
    await tech.next(FrameType.positions);
  });

  it('acks a command, and a rejected one carries its error code', async () => {
    const ops = await connect(H1, ['floor']);
    const from = ops.frames.length;

    const ok = await ops.command('mv', {
      name: 'move_asset',
      args: { assetId: 'IVP-101', toZoneId: 'ICU-303' },
    });
    expect(ok).toMatchObject({ ok: true });
    expect(ok.error).toBeUndefined();
    const changed = await ops.next(FrameType.assetChanged, (f) => f.assetId === 'IVP-101', from);
    expect(changed).toMatchObject({ to: 'ICU-303', status: 'IN_USE' });

    const bad = await ops.command('mv', {
      name: 'move_asset',
      args: { assetId: 'IVP-101', toZoneId: 'SPD' },
    });
    expect(bad).toMatchObject({ ok: false, error: 'INVALID_TRANSITION' });
    const missing = await ops.command('dl', {
      name: 'deliver_wo',
      args: { orderNumber: 'WO9999999' },
    });
    expect(missing).toMatchObject({ ok: false, error: 'NOT_FOUND' });
  });

  it('replays the cached ack for a duplicate cmdId without re-applying the command', async () => {
    const ops = await connect(H1, ['floor']);
    const first = await ops.command('dup', surge, 'same-id');
    const second = await ops.command('dup', surge, 'same-id');
    expect(second).toEqual(first);

    const observer = await connect(H1);
    expect(observer.of(FrameType.hello)[0]!.snapshot.par.clean).toBe(4);
    expect(ops.of(FrameType.assetChanged)).toHaveLength(4);
  });

  it('race: two techs accept the same order — exactly one wins', async () => {
    const ops = await connect(H1, ['role:ops']);
    const techA = await connect(H1, ['role:tech']);
    const techB = await connect(H1, ['role:tech']);
    const { order } = await breachPar(ops);
    await techA.next(FrameType.workOrder, (f) => f.order.number === order.number);
    await techB.next(FrameType.workOrder, (f) => f.order.number === order.number);

    const acks = await Promise.all([
      techA.command('acc', {
        name: 'accept_wo',
        args: { orderNumber: order.number, techId: 'tech-a' },
      }),
      techB.command('acc', {
        name: 'accept_wo',
        args: { orderNumber: order.number, techId: 'tech-b' },
      }),
    ]);

    expect(acks.filter((a) => a.ok)).toHaveLength(1);
    expect(acks.filter((a) => !a.ok).map((a) => a.error)).toEqual(['ALREADY_ASSIGNED']);
    const accepted = await ops.next(FrameType.workOrder, (f) => f.order.state === 'accepted');
    const winner = acks[0]!.ok ? 'tech-a' : 'tech-b';
    expect(accepted.order.assigned_to).toBe(winner);
  });

  it('isolates hospitals: one world’s commands never reach another', async () => {
    const ops1 = await connect(H1, ['floor', 'role:ops']);
    const ops2 = await connect(H2, ['floor', 'role:ops']);

    await breachPar(ops1);
    await delay(300);

    expect(ops2.of(FrameType.assetChanged)).toEqual([]);
    expect(ops2.of(FrameType.workOrder)).toEqual([]);
    const fresh = await connect(H2);
    expect(fresh.of(FrameType.hello)[0]!.snapshot.par.clean).toBe(8);
    expect(app.registry.size).toBe(2);
  });

  it('closes with 4400 on an invalid frame or a bad hospital id', async () => {
    const client = await connect(H1);
    await client.sendRaw(JSON.stringify({ v: 2, ts: 0, type: 'subscribe', topics: [] }));
    expect((await client.closed).code).toBe(CLOSE_BAD_FRAME);

    const badId = new TestClient(app.port, '?h=NOPE');
    clients.push(badId);
    expect((await badId.closed).code).toBe(CLOSE_BAD_FRAME);
  });

  it('closes with 4503 when every world slot is held by a live socket', async () => {
    const small = await startApp({
      sink: new HistorySink(historyDir),
      serviceNow: new ServiceNowMock(() => {}),
      maxWorlds: 1,
    });
    try {
      const holder = await TestClient.connect(small.port, H1);
      const refused = new TestClient(small.port, `?h=${H2}`);
      expect((await refused.closed).code).toBe(CLOSE_CAPACITY);
      holder.close();
    } finally {
      await small.close();
    }
  });

  it('reports worlds and sockets on /healthz', async () => {
    await connect(H1);
    await connect(H2);
    const res = await fetch(`http://127.0.0.1:${app.port}/healthz`);
    expect(await res.json()).toEqual({ ok: true, worlds: 2, sockets: 2 });
  });
});

describe('WorldRegistry capacity', () => {
  const sub = { topics: new Set<Topic>(), send: () => {} };
  let now = 0;
  let registry: WorldRegistry;

  beforeEach(() => {
    now = 0;
    registry = new WorldRegistry({
      sink: new HistorySink(historyDir),
      serviceNow: new ServiceNowMock(() => {}),
      now: () => now,
      maxWorlds: 2,
      idleMs: 1_000,
      tickMs: 60_000,
    });
  });

  afterEach(() => registry.close());

  it('evicts the longest-idle world at the cap, and refuses when none is idle', () => {
    registry.acquire('aaaaaaaa');
    now = 10;
    registry.acquire('bbbbbbbb');
    expect(registry.acquire('cccccccc')).not.toBeNull();
    expect(registry.get('aaaaaaaa')).toBeUndefined();
    expect(registry.get('bbbbbbbb')).toBeDefined();

    registry.get('bbbbbbbb')!.attach(sub);
    registry.get('cccccccc')!.attach(sub);
    expect(registry.acquire('dddddddd')).toBeNull();
  });

  it('garbage-collects worlds idle past idleMs, never attached ones', () => {
    registry.acquire('aaaaaaaa');
    registry.acquire('bbbbbbbb')!.attach(sub);
    now = 999;
    registry.sweep();
    expect(registry.size).toBe(2);
    now = 1_000;
    registry.sweep();
    expect(registry.get('aaaaaaaa')).toBeUndefined();
    expect(registry.get('bbbbbbbb')).toBeDefined();
  });
});
