import {
  BACKPRESSURE_BYTES,
  EVENT_LOG_SIZE,
  FrameType,
  MAX_WORLDS,
  POSITION_FLUSH_MS,
  PROTOCOL_VERSION,
  SIM_TICK_MS,
  WORLD_IDLE_MS,
  type Command,
  type SequencedEvent,
  type ServerFrame,
  type Topic,
} from '@assetpulse/protocol';
import type { HistorySink } from '../adapters/history-sink.js';
import type { ServiceNowMock } from '../adapters/servicenow-mock.js';
import { CommandCache, type Ack } from '../world/command-cache.js';
import { EventLog } from '../world/event-log.js';
import { Simulator, type Position } from '../world/simulator.js';
import { World, WorldError, type WorldEvent } from '../world/world.js';

/** What a hub needs from a socket: its subscriptions, its send queue, and a way to send. */
export interface Subscriber {
  readonly topics: ReadonlySet<Topic>;
  /** Bytes queued but not yet written to the network (`ws.bufferedAmount`). */
  readonly bufferedAmount: number;
  send(frame: ServerFrame): void;
}

/** Server-wide delivery counters, shared by every hub and reported on `/healthz`. */
export interface DeliveryStats {
  /** Position flushes skipped for a client whose send queue was over `BACKPRESSURE_BYTES`. */
  positionSkips: number;
}

/** Which topics each sequenced event fans out to. Positions go to `floor`. */
const EVENT_TOPICS: Record<SequencedEvent['type'], readonly Topic[]> = {
  work_order: ['role:tech', 'role:ops'],
  asset_changed: ['floor'],
  par_alert: ['floor'],
};

export interface HubDeps {
  sink: HistorySink;
  serviceNow: ServiceNowMock;
  now: () => number;
  tickMs: number;
  flushMs: number;
  eventLogSize: number;
  stats: DeliveryStats;
  seed: number;
}

/** Applies one validated command to the World; illegal requests throw a `WorldError`. */
function apply(world: World, command: Command): WorldEvent[] {
  switch (command.name) {
    case 'move_asset':
      return world.moveAsset(command.args.assetId, command.args.toZoneId);
    case 'surge':
      return world.surge();
    case 'reset':
      return world.reset();
    case 'accept_wo':
      return world.acceptOrder(command.args.orderNumber, command.args.techId);
    case 'deliver_wo':
      return world.deliverOrder(command.args.orderNumber);
  }
}

/**
 * One hospital's live sandbox: the World, its simulator tick, event log, command cache, and
 * the sockets attached to it. Every change — from a tick or a command — goes out through
 * `publish`, so logging, history, ServiceNow, and fan-out can never disagree.
 */
export class WorldHub {
  readonly world: World;
  readonly log: EventLog;
  private readonly cache = new CommandCache();
  private readonly simulator: Simulator;
  private readonly subscribers = new Set<Subscriber>();
  /** Latest position per asset since the last flush — ephemeral, never sequenced. */
  private readonly pendingPositions = new Map<string, Position>();
  private timer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  /** When the last socket left; null while any socket is attached. */
  idleSince: number | null;

  constructor(
    readonly hospitalId: string,
    private readonly deps: HubDeps,
  ) {
    this.world = new World({ now: deps.now });
    this.log = new EventLog({ capacity: deps.eventLogSize, now: deps.now });
    this.simulator = new Simulator(this.world, {
      seed: deps.seed,
      hasTech: () => this.hasTopic('role:tech'),
    });
    this.idleSince = deps.now();
  }

  get socketCount(): number {
    return this.subscribers.size;
  }

  start(): void {
    this.timer ??= setInterval(() => this.tick(), this.deps.tickMs);
    this.flushTimer ??= setInterval(() => this.flushPositions(), this.deps.flushMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.timer = null;
    this.flushTimer = null;
  }

  attach(subscriber: Subscriber): void {
    this.subscribers.add(subscriber);
    this.idleSince = null;
  }

  detach(subscriber: Subscriber): void {
    this.subscribers.delete(subscriber);
    if (this.subscribers.size === 0) this.idleSince = this.deps.now();
  }

  hello(): ServerFrame {
    return {
      v: PROTOCOL_VERSION,
      ts: this.deps.now(),
      type: FrameType.hello,
      worldId: this.hospitalId,
      seq: this.log.seq,
      snapshot: this.world.snapshot(),
    };
  }

  /**
   * What a client resuming from `lastSeq` should receive: the missed events it is subscribed
   * to, in order — or a `resync` snapshot when they have been evicted (or it is ahead of us).
   */
  replay(lastSeq: number, topics: ReadonlySet<Topic>): ServerFrame[] {
    const missed = this.log.since(lastSeq);
    if (!missed) {
      return [
        {
          v: PROTOCOL_VERSION,
          ts: this.deps.now(),
          type: FrameType.resync,
          seq: this.log.seq,
          snapshot: this.world.snapshot(),
        },
      ];
    }
    return missed.filter((event) => EVENT_TOPICS[event.type].some((t) => topics.has(t)));
  }

  /** Runs a command at most once per `cmdId`; a retry gets the original ack back. */
  execute(cmdId: string, command: Command): Ack {
    const cached = this.cache.get(cmdId);
    if (cached) return cached;
    const ack = this.run(cmdId, command);
    this.cache.set(cmdId, ack);
    return ack;
  }

  tick(): void {
    const { events, positions } = this.simulator.tick(this.deps.tickMs);
    this.publish(events);
    for (const position of positions) this.pendingPositions.set(position.assetId, position);
  }

  /**
   * Sends the coalesced positions as one frame per `floor` subscriber. A client whose send
   * queue is backed up skips this flush (the next one carries newer positions anyway);
   * events never take this path, so they are never dropped.
   */
  flushPositions(): void {
    if (this.pendingPositions.size === 0) return;
    const frame: ServerFrame = {
      v: PROTOCOL_VERSION,
      ts: this.deps.now(),
      type: FrameType.positions,
      batch: [...this.pendingPositions.values()],
    };
    this.pendingPositions.clear();
    for (const subscriber of this.subscribers) {
      if (!subscriber.topics.has('floor')) continue;
      if (subscriber.bufferedAmount > BACKPRESSURE_BYTES) {
        this.deps.stats.positionSkips++;
        continue;
      }
      subscriber.send(frame);
    }
  }

  private run(cmdId: string, command: Command): Ack {
    const ack: Ack = {
      v: PROTOCOL_VERSION,
      ts: this.deps.now(),
      type: FrameType.ack,
      cmdId,
      ok: true,
    };
    try {
      this.publish(apply(this.world, command));
      return ack;
    } catch (err) {
      if (!(err instanceof WorldError)) throw err;
      return { ...ack, ok: false, error: err.code };
    }
  }

  private publish(events: WorldEvent[]): void {
    for (const event of events) {
      const stamped = this.log.append(event);
      this.deps.sink.record(this.hospitalId, stamped);
      if (stamped.type === FrameType.workOrder) {
        this.deps.serviceNow.submit(this.hospitalId, stamped.order);
      }
      this.broadcast(EVENT_TOPICS[stamped.type], stamped);
    }
  }

  private broadcast(topics: readonly Topic[], frame: ServerFrame): void {
    for (const subscriber of this.subscribers) {
      if (topics.some((t) => subscriber.topics.has(t))) subscriber.send(frame);
    }
  }

  private hasTopic(topic: Topic): boolean {
    return [...this.subscribers].some((s) => s.topics.has(topic));
  }
}

export interface RegistryOptions {
  sink: HistorySink;
  serviceNow: ServiceNowMock;
  now?: () => number;
  maxWorlds?: number;
  idleMs?: number;
  tickMs?: number;
  flushMs?: number;
  eventLogSize?: number;
  /** How often idle worlds are swept. */
  sweepMs?: number;
  /** Per-hospital simulator seed; defaults to a hash of the id, so a sandbox replays. */
  seedFor?: (hospitalId: string) => number;
}

/** FNV-1a: a stable 32-bit seed from a hospital id. */
function hashSeed(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * Get-or-create one WorldHub per hospital id, capped at `maxWorlds`. At the cap the
 * longest-idle world is evicted; with none idle, `acquire` returns null (close 4503).
 * Worlds idle past `idleMs` are garbage-collected by a periodic sweep.
 */
export class WorldRegistry {
  private readonly hubs = new Map<string, WorldHub>();
  private readonly deps: Omit<HubDeps, 'seed'>;
  private readonly maxWorlds: number;
  private readonly idleMs: number;
  private readonly seedFor: (hospitalId: string) => number;
  private readonly sweeper: NodeJS.Timeout;
  readonly stats: DeliveryStats = { positionSkips: 0 };

  constructor(options: RegistryOptions) {
    this.deps = {
      sink: options.sink,
      serviceNow: options.serviceNow,
      now: options.now ?? Date.now,
      tickMs: options.tickMs ?? SIM_TICK_MS,
      flushMs: options.flushMs ?? POSITION_FLUSH_MS,
      eventLogSize: options.eventLogSize ?? EVENT_LOG_SIZE,
      stats: this.stats,
    };
    this.maxWorlds = options.maxWorlds ?? MAX_WORLDS;
    this.idleMs = options.idleMs ?? WORLD_IDLE_MS;
    this.seedFor = options.seedFor ?? hashSeed;
    this.sweeper = setInterval(() => this.sweep(), options.sweepMs ?? 60_000);
    this.sweeper.unref();
  }

  get size(): number {
    return this.hubs.size;
  }

  get(hospitalId: string): WorldHub | undefined {
    return this.hubs.get(hospitalId);
  }

  acquire(hospitalId: string): WorldHub | null {
    const existing = this.hubs.get(hospitalId);
    if (existing) return existing;
    if (this.hubs.size >= this.maxWorlds && !this.evictOldestIdle()) return null;
    const hub = new WorldHub(hospitalId, { ...this.deps, seed: this.seedFor(hospitalId) });
    this.hubs.set(hospitalId, hub);
    hub.start();
    return hub;
  }

  /** Drops every world idle for at least `idleMs`. */
  sweep(): void {
    const now = this.deps.now();
    for (const hub of this.hubs.values()) {
      if (hub.idleSince !== null && now - hub.idleSince >= this.idleMs) this.drop(hub);
    }
  }

  close(): void {
    clearInterval(this.sweeper);
    for (const hub of this.hubs.values()) this.drop(hub);
  }

  private evictOldestIdle(): boolean {
    const idle = [...this.hubs.values()].filter((h) => h.idleSince !== null);
    const oldest = idle.sort((a, b) => (a.idleSince ?? 0) - (b.idleSince ?? 0))[0];
    if (!oldest) return false;
    this.drop(oldest);
    return true;
  }

  private drop(hub: WorldHub): void {
    hub.stop();
    this.hubs.delete(hub.hospitalId);
  }
}
