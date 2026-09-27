import { FrameType, SIM_TICK_MS, ZONES, type Rect } from '@assetpulse/protocol';
import { describe, expect, it } from 'vitest';
import { BOT_TECH_ID, Simulator, type TickResult } from '../src/world/simulator.js';
import { World, type WorldEvent } from '../src/world/world.js';

const T0 = 1_760_000_000_000;

function setup(seed = 42, hasTech: () => boolean = () => true) {
  const world = new World({ now: () => T0 });
  return { world, sim: new Simulator(world, { seed, hasTech }) };
}

/** Runs n ticks; results[i] is tick i + 1 (elapsed = (i + 1) × 100 ms). */
function run(sim: Simulator, n: number): TickResult[] {
  return Array.from({ length: n }, () => sim.tick(SIM_TICK_MS));
}

/** 1-based tick of the first event matching `match`, or 0 if none. */
function tickOf(results: TickResult[], match: (e: WorldEvent) => boolean): number {
  return results.findIndex((r) => r.events.some(match)) + 1;
}

function statusEvent(assetId: string, status: string) {
  return (e: WorldEvent) =>
    e.type === FrameType.assetChanged && e.assetId === assetId && e.status === status;
}

function orderState(state: string) {
  return (e: WorldEvent) => e.type === FrameType.workOrder && e.order.state === state;
}

/** Surge plus two bedside moves: the clean shelf drops below PAR min. */
function breach(world: World): void {
  world.surge();
  world.moveAsset('IVP-105', 'MS-307');
  world.moveAsset('IVP-106', 'MS-308');
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
    expect(a.flatMap((r) => r.events).length).toBeGreaterThan(5);
  });

  it('diverges for a different seed', () => {
    const a = run(setup(7).sim, 600);
    const b = run(setup(8).sim, 600);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('fires a room event every 6–10 s', () => {
    const results = run(setup(3).sim, 600);
    const roomTicks = results.flatMap((r, i) =>
      r.events.some(
        (e) =>
          e.type === FrameType.assetChanged && e.status !== 'REPROCESSING' && e.status !== 'READY',
      )
        ? [i + 1]
        : [],
    );
    expect(roomTicks[0]).toBeGreaterThanOrEqual(60);
    expect(roomTicks[0]).toBeLessThanOrEqual(100);
    for (let i = 1; i < roomTicks.length; i++) {
      const gap = (roomTicks[i] as number) - (roomTicks[i - 1] as number);
      expect(gap).toBeLessThanOrEqual(100);
    }
  });
});

describe('Simulator timers', () => {
  it('finishes reprocessing on exactly the 15 s tick', () => {
    const results = run(setup().sim, 200);
    expect(tickOf(results, statusEvent('IVP-113', 'READY'))).toBe(150);
    expect(tickOf(results, statusEvent('IVP-114', 'READY'))).toBe(150);
  });

  it('sends a soiled pump to SPD on exactly the 8 s tick', () => {
    const { world, sim } = setup();
    world.moveAsset('IVP-109', 'SOILED-UTIL');
    const results = run(sim, 100);
    expect(tickOf(results, statusEvent('IVP-109', 'REPROCESSING'))).toBe(80);
  });

  it('times a change made between ticks from the tick it was seen', () => {
    const { world, sim } = setup();
    run(sim, 10);
    world.moveAsset('IVP-110', 'SOILED-UTIL');
    const results = run(sim, 100);
    // Seen at elapsed 1000 ms; fires at 9000 ms = the 80th tick after the first 10.
    expect(tickOf(results, statusEvent('IVP-110', 'REPROCESSING'))).toBe(80);
  });
});

describe('Simulator demo bot', () => {
  it('accepts only after 45 s with no tech, then delivers', () => {
    const { world, sim } = setup(42, () => false);
    breach(world);
    const results = run(sim, 600);
    expect(tickOf(results, orderState('open'))).toBe(1);
    const accepted = tickOf(results, orderState('accepted'));
    // Opened at 100 ms; accepted 45 000 ms later.
    expect(accepted).toBe(451);
    const acceptEvent = results[accepted - 1]?.events.find(orderState('accepted'));
    expect(acceptEvent?.type === FrameType.workOrder && acceptEvent.order.assigned_to).toBe(
      BOT_TECH_ID,
    );
    expect(tickOf(results.slice(accepted), orderState('closed'))).toBeGreaterThan(0);
  });

  it('never accepts while a tech is online', () => {
    const { world, sim } = setup(42, () => true);
    breach(world);
    expect(tickOf(run(sim, 600), orderState('accepted'))).toBe(0);
  });

  it('restarts the 45 s wait when the tech goes offline', () => {
    let tech = true;
    const { world, sim } = setup(42, () => tech);
    breach(world);
    const online = run(sim, 100);
    tech = false;
    const offline = run(sim, 500);
    expect(tickOf(online, orderState('accepted'))).toBe(0);
    // Last reset at 10 000 ms; accepted at 55 000 ms = the 450th offline tick.
    expect(tickOf(offline, orderState('accepted'))).toBe(450);
  });
});

describe('Simulator positions', () => {
  it('reports every asset each tick, jittering at most 6 units inside its zone', () => {
    const results = run(setup().sim, 50);
    for (const r of results) expect(r.positions).toHaveLength(14);
    for (let i = 1; i < results.length; i++) {
      expectJitterStep(results[i - 1] as TickResult, results[i] as TickResult);
    }
  });

  it('tweens a zone change through the hall over 1.5 s', () => {
    const { world, sim } = setup();
    world.surge(); // IVP-101 → ICU-301
    const path = run(sim, 15).map((r) => r.positions.find((p) => p.assetId === 'IVP-101'));
    expect(path.every((p) => p?.zoneId === 'ICU-301')).toBe(true);
    expect(path.some((p) => p && inside(rect('HALL'), p))).toBe(true);
    expect(inside(rect('ICU-301'), path[14] ?? { x: 0, y: 0 })).toBe(true);
  });
});
