import {
  DEMO_BOT_DELAY_MS,
  REPROCESSING_MS,
  ROOM_EVENT_MAX_MS,
  ROOM_EVENT_MIN_MS,
  SOILED_TO_REPROCESSING_MS,
  ZONES,
  type Asset,
  type AssetStatus,
  type FrameType,
  type Rect,
  type ServerFrame,
  type WorkOrder,
} from '@assetpulse/protocol';
import { mulberry32, pick, randInt, type Rng } from './rng.js';
import type { World, WorldEvent } from './world.js';

export type Position = Extract<ServerFrame, { type: typeof FrameType.positions }>['batch'][number];

export interface SimulatorOptions {
  seed: number;
  /** True while any socket is subscribed to `role:tech`; the demo bot stands down. */
  hasTech: () => boolean;
}

export interface TickResult {
  events: WorldEvent[];
  positions: Position[];
}

/** `assigned_to` on orders the demo bot accepts. */
export const BOT_TECH_ID = 'demo-bot';

const JITTER = 6;
/** Keeps dots off the zone walls. */
const INSET = 8;
const TWEEN_MS = 1_500;
const SPD_ZONE = 'SPD';
const SOILED_ZONE = 'SOILED-UTIL';

/** Statuses that advance on their own, and how long they take. Both steps land in SPD. */
const TIMERS: Partial<Record<AssetStatus, number>> = {
  SOILED: SOILED_TO_REPROCESSING_MS,
  REPROCESSING: REPROCESSING_MS,
};

const RECTS = new Map(ZONES.map((z) => [z.id, z.rect]));
const ROOMS = ZONES.filter((z) => z.kind === 'room').map((z) => z.id);

interface Point {
  x: number;
  y: number;
}

interface Tween {
  from: Point;
  to: Point;
  start: number;
}

/** What the simulator last saw of an asset, plus its on-screen motion. */
interface Tracked {
  status: AssetStatus;
  zoneId: string;
  /** Sim time the asset entered its current status; drives the timers. */
  since: number;
  pos: Point;
  tween: Tween | null;
}

function rectOf(zoneId: string): Rect {
  const rect = RECTS.get(zoneId);
  if (!rect) throw new Error(`no rect for zone ${zoneId}`);
  return rect;
}

const HALL = rectOf('HALL');
const HALL_CENTER: Point = { x: HALL.x + HALL.w / 2, y: HALL.y + HALL.h / 2 };

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function clampTo(rect: Rect, p: Point): Point {
  return {
    x: clamp(p.x, rect.x + INSET, rect.x + rect.w - INSET),
    y: clamp(p.y, rect.y + INSET, rect.y + rect.h - INSET),
  };
}

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Constant-speed position along from → hall centroid → to. */
function tweenAt(tween: Tween, elapsed: number): Point {
  const t = (elapsed - tween.start) / TWEEN_MS;
  if (t >= 1) return tween.to;
  const first = Math.hypot(HALL_CENTER.x - tween.from.x, HALL_CENTER.y - tween.from.y);
  const second = Math.hypot(tween.to.x - HALL_CENTER.x, tween.to.y - HALL_CENTER.y);
  const d = t * (first + second);
  return d < first
    ? lerp(tween.from, HALL_CENTER, d / first)
    : lerp(HALL_CENTER, tween.to, (d - first) / second);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Drives one World in demo time: lifecycle timers, random room events, the demo bot, and
 * asset positions. All randomness comes from the seeded RNG, so a seed replays exactly.
 * It watches the World through snapshots, so changes made by commands between ticks
 * (moves, surge, reset, deliveries) start their timers and tweens too.
 */
export class Simulator {
  private readonly rng: Rng;
  private readonly hasTech: () => boolean;
  private elapsed = 0;
  private nextRoomEventAt: number;
  private readonly tracked = new Map<string, Tracked>();
  /** Open orders → sim time their no-tech wait began. */
  private readonly waitingSince = new Map<string, number>();
  private readonly botOrders = new Set<string>();

  constructor(
    private readonly world: World,
    options: SimulatorOptions,
  ) {
    this.rng = mulberry32(options.seed);
    this.hasTech = options.hasTech;
    this.nextRoomEventAt = this.roomEventGap();
    this.observe();
  }

  tick(dtMs: number): TickResult {
    this.observe();
    this.elapsed += dtMs;
    const events = [...this.runTimers(), ...this.runRoomEvent(), ...this.runBot()];
    events.push(...this.world.evaluatePar());
    this.observe();
    return { events, positions: this.advancePositions() };
  }

  // --- world changes ---------------------------------------------------------

  private runTimers(): WorldEvent[] {
    const events: WorldEvent[] = [];
    for (const [assetId, t] of this.tracked) {
      const delay = TIMERS[t.status];
      if (delay !== undefined && this.elapsed - t.since >= delay) {
        events.push(...this.world.moveAsset(assetId, SPD_ZONE));
      }
    }
    return events;
  }

  /** Every 6–10 s a room requests a clean pump or discharges one, 50/50. */
  private runRoomEvent(): WorldEvent[] {
    if (this.elapsed < this.nextRoomEventAt) return [];
    this.nextRoomEventAt = this.elapsed + this.roomEventGap();
    return this.rng() < 0.5 ? this.requestPump() : this.dischargePump();
  }

  private requestPump(): WorldEvent[] {
    const room = pick(this.rng, ROOMS);
    const pump = pick(this.rng, this.assetsIn('CLEAN'));
    return room && pump ? this.world.moveAsset(pump.id, room) : [];
  }

  private dischargePump(): WorldEvent[] {
    const pump = pick(this.rng, this.assetsIn('IN_USE'));
    return pump ? this.world.moveAsset(pump.id, SOILED_ZONE) : [];
  }

  /** Delivers what it accepted once a pump is READY, then accepts orders left waiting. */
  private runBot(): WorldEvent[] {
    const { workOrders } = this.world.snapshot();
    return [...this.botDeliveries(workOrders), ...this.botAccepts(workOrders)];
  }

  private botDeliveries(orders: WorkOrder[]): WorldEvent[] {
    if (this.assetsIn('READY').length === 0) return [];
    return orders
      .filter((o) => o.state === 'accepted' && this.botOrders.has(o.number))
      .flatMap((o) => this.world.deliverOrder(o.number));
  }

  /** An order is accepted after DEMO_BOT_DELAY_MS open with no tech online; a tech resets it. */
  private botAccepts(orders: WorkOrder[]): WorldEvent[] {
    const techOnline = this.hasTech();
    const events: WorldEvent[] = [];
    for (const order of orders.filter((o) => o.state === 'open')) {
      if (techOnline) {
        this.waitingSince.set(order.number, this.elapsed);
      } else if (
        this.elapsed - (this.waitingSince.get(order.number) ?? this.elapsed) >=
        DEMO_BOT_DELAY_MS
      ) {
        events.push(...this.world.acceptOrder(order.number, BOT_TECH_ID));
        this.botOrders.add(order.number);
      }
    }
    return events;
  }

  // --- observation -----------------------------------------------------------

  private observe(): void {
    const { assets, workOrders } = this.world.snapshot();
    for (const asset of assets) this.track(asset);
    this.trackOrders(workOrders);
  }

  private track(asset: Asset): void {
    const prev = this.tracked.get(asset.id);
    if (!prev) {
      this.tracked.set(asset.id, {
        status: asset.status,
        zoneId: asset.zoneId,
        since: this.elapsed,
        pos: this.randomPointIn(asset.zoneId),
        tween: null,
      });
      return;
    }
    if (prev.status !== asset.status) {
      prev.status = asset.status;
      prev.since = this.elapsed;
    }
    if (prev.zoneId !== asset.zoneId) {
      prev.zoneId = asset.zoneId;
      prev.tween = { from: prev.pos, to: this.randomPointIn(asset.zoneId), start: this.elapsed };
    }
  }

  /** Forgets closed orders; starts the bot's wait clock on newly opened ones. */
  private trackOrders(orders: WorkOrder[]): void {
    const active = new Set(orders.map((o) => o.number));
    for (const number of [...this.waitingSince.keys(), ...this.botOrders]) {
      if (!active.has(number)) {
        this.waitingSince.delete(number);
        this.botOrders.delete(number);
      }
    }
    for (const order of orders) {
      if (order.state === 'open' && !this.waitingSince.has(order.number)) {
        this.waitingSince.set(order.number, this.elapsed);
      }
    }
  }

  // --- positions -------------------------------------------------------------

  private advancePositions(): Position[] {
    return [...this.tracked].map(([assetId, t]) => {
      const p = this.step(t);
      return { assetId, zoneId: t.zoneId, x: round1(p.x), y: round1(p.y) };
    });
  }

  private step(t: Tracked): Point {
    if (t.tween) {
      t.pos = tweenAt(t.tween, this.elapsed);
      if (this.elapsed - t.tween.start >= TWEEN_MS) t.tween = null;
      return t.pos;
    }
    const jittered = { x: t.pos.x + this.jitter(), y: t.pos.y + this.jitter() };
    t.pos = clampTo(rectOf(t.zoneId), jittered);
    return t.pos;
  }

  // --- helpers ---------------------------------------------------------------

  private jitter(): number {
    return (this.rng() * 2 - 1) * JITTER;
  }

  private randomPointIn(zoneId: string): Point {
    const r = rectOf(zoneId);
    return {
      x: r.x + INSET + this.rng() * (r.w - 2 * INSET),
      y: r.y + INSET + this.rng() * (r.h - 2 * INSET),
    };
  }

  private roomEventGap(): number {
    return randInt(this.rng, ROOM_EVENT_MIN_MS, ROOM_EVENT_MAX_MS);
  }

  private assetsIn(status: AssetStatus): Asset[] {
    return this.world.snapshot().assets.filter((a) => a.status === status);
  }
}
