import { ZONES, type FrameType, type Rect, type ServerFrame } from '@assetpulse/protocol';
import { mulberry32, type Rng } from './rng.js';
import type { World, WorldEvent } from './world.js';

export type Position = Extract<ServerFrame, { type: typeof FrameType.positions }>['batch'][number];

export interface SimulatorOptions {
  seed: number;
}

export interface TickResult {
  events: WorldEvent[];
  positions: Position[];
}

const JITTER = 6;
/** Keeps dots off the zone walls. */
const INSET = 8;
const TWEEN_MS = 1_500;

const RECTS = new Map(ZONES.map((z) => [z.id, z.rect]));

interface Point {
  x: number;
  y: number;
}

interface Tween {
  from: Point;
  to: Point;
  start: number;
}

/** Where the simulator last saw an asset, plus its on-screen motion. */
interface Tracked {
  zoneId: string;
  pos: Point;
  tween: Tween | null;
}

function rectOf(zoneId: string): Rect {
  const rect = RECTS.get(zoneId);
  if (!rect) throw new Error(`no rect for zone ${zoneId}`);
  return rect;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function clampTo(rect: Rect, p: Point): Point {
  return {
    x: clamp(p.x, rect.x + INSET, rect.x + rect.w - INSET),
    y: clamp(p.y, rect.y + INSET, rect.y + rect.h - INSET),
  };
}

/** Constant-speed position on the straight line from → to. */
function tweenAt(tween: Tween, elapsed: number): Point {
  const t = Math.min(1, (elapsed - tween.start) / TWEEN_MS);
  return {
    x: tween.from.x + (tween.to.x - tween.from.x) * t,
    y: tween.from.y + (tween.to.y - tween.from.y) * t,
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Drives one World in demo time: the PAR check every tick, and the RTLS position stream. Only a
 * person moves pumps between zones; the simulator never does. All randomness comes from the
 * seeded RNG, so a seed replays exactly. It watches the World through snapshots, so moves,
 * restocks, and resets made by commands between ticks start their tweens too.
 */
export class Simulator {
  private readonly rng: Rng;
  private elapsed = 0;
  private readonly tracked = new Map<string, Tracked>();

  constructor(
    private readonly world: World,
    options: SimulatorOptions,
  ) {
    this.rng = mulberry32(options.seed);
    this.observe();
  }

  tick(dtMs: number): TickResult {
    this.elapsed += dtMs;
    const events = this.world.evaluatePar();
    this.observe();
    return { events, positions: this.advancePositions() };
  }

  // --- observation -----------------------------------------------------------

  /** Places new pumps, starts tweens for moved ones, and forgets pumps a reset removed. */
  private observe(): void {
    const { assets } = this.world.snapshot();
    const live = new Set(assets.map((a) => a.id));
    for (const id of this.tracked.keys()) if (!live.has(id)) this.tracked.delete(id);
    for (const asset of assets) this.track(asset.id, asset.zoneId);
  }

  private track(assetId: string, zoneId: string): void {
    const prev = this.tracked.get(assetId);
    if (!prev) {
      this.tracked.set(assetId, { zoneId, pos: this.randomPointIn(zoneId), tween: null });
    } else if (prev.zoneId !== zoneId) {
      prev.zoneId = zoneId;
      prev.tween = { from: prev.pos, to: this.randomPointIn(zoneId), start: this.elapsed };
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
}
