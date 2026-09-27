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

const ZONE_CENTERS = new Map(
  ZONES.map((z) => [z.id, { x: z.rect.x + z.rect.w / 2, y: z.rect.y + z.rect.h / 2 }]),
);

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Smooths 4 Hz position batches into 60 fps motion: each batch starts a tween from wherever the
 * dot is drawn now to the reported point, lasting one flush interval. Lives outside React state
 * so animation never re-renders the tree.
 */
export class PositionTracker {
  private readonly tracks = new Map<string, Track>();

  push(batch: Batch, now: number): void {
    for (const { assetId, x, y } of batch) {
      const from = this.at(assetId, now) ?? { x, y };
      this.tracks.set(assetId, { from, to: { x, y }, t0: now });
    }
  }

  /** Drawn position, or null before the asset's first batch. */
  at(assetId: string, now: number): Point | null {
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
