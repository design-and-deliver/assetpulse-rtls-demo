import { describe, expect, it } from 'vitest';
import {
  FLOOR_HEIGHT,
  FLOOR_WIDTH,
  INITIAL_ASSETS,
  PAR,
  RECONNECT_MAX_MS,
  ZONES,
  ZONE_IDS,
  reconnectDelayMs,
  type Rect,
} from '../src/index.js';

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe('floor model', () => {
  it('has unique zone ids', () => {
    expect(new Set(ZONE_IDS).size).toBe(ZONES.length);
  });

  it('keeps every zone inside the floor', () => {
    for (const { rect } of ZONES) {
      expect(rect.x + rect.w).toBeLessThanOrEqual(FLOOR_WIDTH);
      expect(rect.y + rect.h).toBeLessThanOrEqual(FLOOR_HEIGHT);
    }
  });

  it('has no overlapping zones', () => {
    for (const [i, a] of ZONES.entries()) {
      for (const b of ZONES.slice(i + 1))
        expect(overlaps(a.rect, b.rect), `${a.id}/${b.id}`).toBe(false);
    }
  });

  it('places every initial asset in a real zone', () => {
    for (const asset of INITIAL_ASSETS) expect(ZONE_IDS).toContain(asset.zoneId);
  });

  it('starts the clean utility room full to PAR max', () => {
    const clean = INITIAL_ASSETS.filter((a) => a.status === 'CLEAN' && a.zoneId === PAR.zoneId);
    expect(clean).toHaveLength(PAR.max);
    expect(INITIAL_ASSETS).toHaveLength(14);
  });
});

describe('reconnectDelayMs', () => {
  it('doubles from 500 ms and caps at the max, jittered into [50%, 100%)', () => {
    expect(reconnectDelayMs(0, 0)).toBe(250);
    expect(reconnectDelayMs(0, 0.999)).toBeCloseTo(499.75);
    expect(reconnectDelayMs(3, 1)).toBe(4000);
    expect(reconnectDelayMs(10, 1)).toBe(RECONNECT_MAX_MS);
    expect(reconnectDelayMs(10, 0)).toBe(RECONNECT_MAX_MS / 2);
  });
});
