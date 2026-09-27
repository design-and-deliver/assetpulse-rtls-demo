import { POSITION_FLUSH_MS, ZONES, type ServerFrame } from '@assetpulse/protocol';

type Batch = Extract<ServerFrame, { type: 'positions' }>['batch'];
interface Point {
  x: number;
  y: number;
}
interface Track {
  from: Point;
  to: Point;
  t0: number;
}
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** A dot pinned under the pointer (or at its drop point) regardless of what the server says. */
interface Hold {
  point: Point;
  /** Once set, the hold ends on the first server point inside this rect. */
  releaseIn: Rect | null;
}

const ZONE_CENTERS = new Map(
  ZONES.map((z) => [z.id, { x: z.rect.x + z.rect.w / 2, y: z.rect.y + z.rect.h / 2 }]),
);

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function inside(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/**
 * Smooths 4 Hz position batches into 60 fps motion: each batch starts a tween from wherever the
 * dot is drawn now to the reported point, lasting one flush interval. Lives outside React state
 * so animation never re-renders the tree.
 */
export class PositionTracker {
  private readonly tracks = new Map<string, Track>();
  private readonly holds = new Map<string, Hold>();

  push(batch: Batch, now: number): void {
    for (const { assetId, x, y } of batch) {
      const from = this.at(assetId, now) ?? { x, y };
      this.tracks.set(assetId, { from, to: { x, y }, t0: now });
      const hold = this.holds.get(assetId);
      if (hold?.releaseIn && inside(hold.releaseIn, { x, y })) this.holds.delete(assetId);
    }
  }

  /** Pins a dot at `point` (SVG units) — used while dragging and until the server agrees. */
  hold(assetId: string, point: Point): void {
    this.holds.set(assetId, { point, releaseIn: null });
  }

  /**
   * Keeps a dropped dot where it landed until the server reports it inside `rect` — the server
   * walks it there from its old spot, and following that walk would look like a snap-back.
   */
  releaseWhenIn(assetId: string, rect: Rect): void {
    const hold = this.holds.get(assetId);
    if (hold) hold.releaseIn = rect;
  }

  /** Gives up waiting on a `releaseWhenIn(rect)` hold — a newer drag's hold is left alone. */
  expire(assetId: string, rect: Rect, now: number): void {
    if (this.holds.get(assetId)?.releaseIn === rect) this.release(assetId, now);
  }

  /** Ends a hold now, tweening from the held point back to the server's latest point. */
  release(assetId: string, now: number): void {
    const hold = this.holds.get(assetId);
    if (!hold) return;
    this.holds.delete(assetId);
    const track = this.tracks.get(assetId);
    if (track) this.tracks.set(assetId, { from: hold.point, to: track.to, t0: now });
  }

  /** Drawn position, or null before the asset's first batch. */
  at(assetId: string, now: number): Point | null {
    const hold = this.holds.get(assetId);
    if (hold) return hold.point;
    const track = this.tracks.get(assetId);
    if (!track) return null;
    const t = Math.min(1, (now - track.t0) / POSITION_FLUSH_MS);
    return { x: lerp(track.from.x, track.to.x, t), y: lerp(track.from.y, track.to.y, t) };
  }

  /** Where to draw an asset: its tracked point, else the middle of its zone. */
  pointFor(assetId: string, zoneId: string, now: number): Point {
    return this.at(assetId, now) ?? ZONE_CENTERS.get(zoneId) ?? { x: 0, y: 0 };
  }
}
