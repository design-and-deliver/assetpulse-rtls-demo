import { FrameType, INITIAL_ASSETS, SIM_TICK_MS, ZONES, type Rect } from '@assetpulse/protocol';
import { describe, expect, it } from 'vitest';
import { Simulator, type TickResult } from '../src/world/simulator.js';
import { World } from '../src/world/world.js';

const T0 = 1_760_000_000_000;

function setup(seed = 42) {
  const world = new World({ now: () => T0 });
  return { world, sim: new Simulator(world, { seed }) };
}

/** Runs n ticks; results[i] is tick i + 1 (elapsed = (i + 1) × 100 ms). */
function run(sim: Simulator, n: number): TickResult[] {
  return Array.from({ length: n }, () => sim.tick(SIM_TICK_MS));
}

function rect(zoneId: string): Rect {
  const zone = ZONES.find((z) => z.id === zoneId);
  if (!zone) throw new Error(zoneId);
  return zone.rect;
}

function inside(r: Rect, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** Each dot stays in its zone and moves at most JITTER (6, plus rounding) per axis. */
function expectJitterStep(before: TickResult, after: TickResult): void {
  for (const p of after.positions) {
    const prev = before.positions.find((q) => q.assetId === p.assetId);
    expect(inside(rect(p.zoneId), p)).toBe(true);
    expect(Math.abs(p.x - (prev?.x ?? 0))).toBeLessThanOrEqual(6.1);
    expect(Math.abs(p.y - (prev?.y ?? 0))).toBeLessThanOrEqual(6.1);
  }
}

describe('Simulator determinism', () => {
  it('replays the same seed identically over 600 ticks', () => {
    const a = run(setup(7).sim, 600);
    const b = run(setup(7).sim, 600);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('diverges for a different seed', () => {
    const a = run(setup(7).sim, 600);
    const b = run(setup(8).sim, 600);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
});

describe('Simulator world changes', () => {
  it('never moves a pump on its own', () => {
    const { world, sim } = setup();
    const before = world.snapshot();
    const results = run(sim, 600);
    expect(results.flatMap((r) => r.events)).toEqual([]);
    expect(world.snapshot()).toEqual(before);
  });

  it('raises the PAR work order on the first tick after a breach', () => {
    const { world, sim } = setup();
    world.moveAsset('IVP-101', 'ICU-301');
    world.moveAsset('IVP-102', 'ICU-302');
    world.moveAsset('IVP-103', 'WARD-303');
    const [first] = run(sim, 1);
    expect(first?.events.map((e) => e.type)).toEqual([FrameType.parAlert, FrameType.workOrder]);
  });
});

describe('Simulator positions', () => {
  it('reports every asset each tick, jittering at most 6 units inside its zone', () => {
    const results = run(setup().sim, 50);
    for (const r of results) expect(r.positions).toHaveLength(INITIAL_ASSETS.length);
    for (let i = 1; i < results.length; i++) {
      expectJitterStep(results[i - 1] as TickResult, results[i] as TickResult);
    }
  });

  it('tweens a zone change over 1.5 s and lands inside the new zone', () => {
    const { world, sim } = setup();
    world.moveAsset('IVP-101', 'ICU-301');
    const path = run(sim, 15).map((r) => r.positions.find((p) => p.assetId === 'IVP-101'));
    expect(path.every((p) => p?.zoneId === 'ICU-301')).toBe(true);
    expect(inside(rect('ICU-301'), path[0] ?? { x: 0, y: 0 })).toBe(false);
    expect(inside(rect('ICU-301'), path[14] ?? { x: 0, y: 0 })).toBe(true);
  });

  it('tracks restocked pumps and forgets them after a reset', () => {
    const { world, sim } = setup();
    world.moveAsset('IVP-101', 'ICU-301');
    world.moveAsset('IVP-102', 'ICU-302');
    world.moveAsset('IVP-103', 'WARD-303');
    const order = run(sim, 1)[0]?.events.find((e) => e.type === FrameType.workOrder);
    if (order?.type !== FrameType.workOrder) throw new Error('no order');
    world.acceptOrder(order.order.number, 'tech-1');
    world.deliverOrder(order.order.number);
    expect(run(sim, 1)[0]?.positions).toHaveLength(INITIAL_ASSETS.length + 3);
    world.reset();
    expect(run(sim, 1)[0]?.positions).toHaveLength(INITIAL_ASSETS.length);
  });
});
