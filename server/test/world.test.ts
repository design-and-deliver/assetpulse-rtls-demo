import { FrameType, PAR } from '@assetpulse/protocol';
import { describe, expect, it } from 'vitest';
import { World, WorldError, type WorldEvent } from '../src/world/world.js';

const T0 = 1_760_000_000_000;

function newWorld(): World {
  return new World({ now: () => T0 });
}

/** Surge (8 → 4 clean), then send two more to bedside: 2 clean, below PAR min 3. */
function breach(world: World): void {
  world.surge();
  world.moveAsset('IVP-105', 'MS-307');
  world.moveAsset('IVP-106', 'MS-308');
}

/** The two pumps that start in SPD finish reprocessing. */
function readyTwo(world: World): void {
  world.moveAsset('IVP-113', 'SPD');
  world.moveAsset('IVP-114', 'SPD');
}

function orderOf(events: WorldEvent[]) {
  const e = events.find((ev) => ev.type === FrameType.workOrder);
  if (!e || e.type !== FrameType.workOrder) throw new Error('no work_order event');
  return e.order;
}

function parAlerts(events: WorldEvent[]): string[] {
  return events.flatMap((e) => (e.type === FrameType.parAlert ? [e.state] : []));
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof WorldError) return err.code;
    throw err;
  }
  return undefined;
}

function statusOf(world: World, assetId: string) {
  return world.snapshot().assets.find((a) => a.id === assetId);
}

describe('World lifecycle', () => {
  it('walks a pump CLEAN → IN_USE → SOILED → REPROCESSING → READY → CLEAN', () => {
    const world = newWorld();
    expect(world.moveAsset('IVP-101', 'ICU-303')).toEqual([
      {
        type: FrameType.assetChanged,
        assetId: 'IVP-101',
        from: 'CLEAN-UTIL',
        to: 'ICU-303',
        status: 'IN_USE',
      },
    ]);
    world.moveAsset('IVP-101', 'SOILED-UTIL');
    world.moveAsset('IVP-101', 'SPD');
    world.moveAsset('IVP-101', 'SPD');
    expect(statusOf(world, 'IVP-101')).toEqual({ id: 'IVP-101', status: 'READY', zoneId: 'SPD' });

    // READY → CLEAN happens only through a delivered work order.
    expect(codeOf(() => world.moveAsset('IVP-101', 'CLEAN-UTIL'))).toBe('INVALID_TRANSITION');
    world.surge(); // 7 → 3 clean
    world.moveAsset('IVP-106', 'MS-307'); // 2 clean: breach
    const number = orderOf(world.evaluatePar()).number;
    world.acceptOrder(number, 'tech-1');
    world.deliverOrder(number);
    expect(statusOf(world, 'IVP-101')).toEqual({
      id: 'IVP-101',
      status: 'CLEAN',
      zoneId: 'CLEAN-UTIL',
    });
  });

  it('rejects an illegal transition and leaves the asset untouched', () => {
    const world = newWorld();
    expect(codeOf(() => world.moveAsset('IVP-101', 'SOILED-UTIL'))).toBe('INVALID_TRANSITION');
    expect(codeOf(() => world.moveAsset('IVP-109', 'HALL'))).toBe('INVALID_TRANSITION');
    expect(statusOf(world, 'IVP-101')).toEqual({
      id: 'IVP-101',
      status: 'CLEAN',
      zoneId: 'CLEAN-UTIL',
    });
  });

  it('reports unknown assets, zones, and orders as NOT_FOUND', () => {
    const world = newWorld();
    expect(codeOf(() => world.moveAsset('IVP-999', 'ICU-301'))).toBe('NOT_FOUND');
    expect(codeOf(() => world.moveAsset('IVP-101', 'ICU-999'))).toBe('NOT_FOUND');
    expect(codeOf(() => world.acceptOrder('WO0000000', 'tech-1'))).toBe('NOT_FOUND');
  });
});

describe('World PAR + work orders', () => {
  it('stays quiet while the clean shelf is at or above min', () => {
    const world = newWorld();
    world.surge();
    expect(world.snapshot().par).toMatchObject({ clean: 4, state: 'OK' });
    expect(world.evaluatePar()).toEqual([]);
  });

  it('opens exactly one work order on a PAR breach', () => {
    const world = newWorld();
    breach(world);
    const events = world.evaluatePar();
    expect(parAlerts(events)).toEqual(['BREACH']);
    expect(orderOf(events)).toEqual({
      number: 'WO0010001',
      state: 'open',
      short_description: expect.any(String),
      assigned_to: null,
      location: PAR.zoneId,
      priority: 2,
      quantity: PAR.max - 2,
      opened_at: T0,
    });
    expect(world.snapshot().workOrders).toHaveLength(1);
  });

  it('does not open a duplicate on a second breach', () => {
    const world = newWorld();
    breach(world);
    world.evaluatePar();
    world.moveAsset('IVP-107', 'MS-305'); // shelf drops further while the order is open
    expect(world.evaluatePar()).toEqual([]);
    const number = world.snapshot().workOrders[0]?.number as string;
    world.acceptOrder(number, 'tech-1');
    expect(world.evaluatePar()).toEqual([]);
    expect(world.snapshot().workOrders).toHaveLength(1);
  });

  it('rejects a second accept with ALREADY_ASSIGNED', () => {
    const world = newWorld();
    breach(world);
    const number = orderOf(world.evaluatePar()).number;
    expect(orderOf(world.acceptOrder(number, 'tech-1'))).toMatchObject({
      state: 'accepted',
      assigned_to: 'tech-1',
    });
    expect(codeOf(() => world.acceptOrder(number, 'tech-2'))).toBe('ALREADY_ASSIGNED');
  });

  it('recomputes quantity on accept', () => {
    const world = newWorld();
    breach(world);
    const number = orderOf(world.evaluatePar()).number;
    world.moveAsset('IVP-107', 'MS-305');
    expect(orderOf(world.acceptOrder(number, 'tech-1')).quantity).toBe(PAR.max - 1);
  });

  it('refuses delivery before accept, and with nothing READY', () => {
    const world = newWorld();
    breach(world);
    const number = orderOf(world.evaluatePar()).number;
    expect(codeOf(() => world.deliverOrder(number))).toBe('NOT_ASSIGNED');
    world.acceptOrder(number, 'tech-1');
    expect(codeOf(() => world.deliverOrder(number))).toBe('NOTHING_READY');
  });

  it('delivers partially when READY < quantity, closes, and stays in breach', () => {
    const world = newWorld();
    breach(world);
    // Shelf at 1 → 7 needed after accept; only one pump is READY.
    world.moveAsset('IVP-107', 'MS-305');
    const number = orderOf(world.evaluatePar()).number;
    world.acceptOrder(number, 'tech-1');
    world.moveAsset('IVP-113', 'SPD');

    const events = world.deliverOrder(number);
    const moved = events.filter((e) => e.type === FrameType.assetChanged);
    expect(moved).toHaveLength(1);
    expect(orderOf(events)).toMatchObject({ number, state: 'closed' });
    expect(parAlerts(events)).toEqual([]); // 2 clean < min 3: no CLEARED
    expect(world.snapshot().workOrders).toEqual([]);

    // The next evaluation opens a fresh order.
    expect(orderOf(world.evaluatePar()).number).toBe('WO0010002');
  });

  it('emits CLEARED only once the shelf is back at or above min', () => {
    const world = newWorld();
    breach(world);
    readyTwo(world);
    const number = orderOf(world.evaluatePar()).number;
    world.acceptOrder(number, 'tech-1');

    const events = world.deliverOrder(number);
    expect(events.filter((e) => e.type === FrameType.assetChanged)).toHaveLength(2);
    expect(parAlerts(events)).toEqual(['CLEARED']);
    expect(world.snapshot().par).toMatchObject({ clean: 4, state: 'OK' });
  });

  it('numbers orders sequentially across reopen and reset', () => {
    const world = newWorld();
    const numbers: string[] = [];
    for (let i = 0; i < 3; i++) {
      breach(world);
      numbers.push(orderOf(world.evaluatePar()).number);
      world.reset();
    }
    expect(numbers).toEqual(['WO0010001', 'WO0010002', 'WO0010003']);
  });
});

describe('World reset', () => {
  it('restores the initial floor and closes active orders', () => {
    const world = newWorld();
    const initial = world.snapshot();
    breach(world);
    world.evaluatePar();

    const events = world.reset();
    expect(orderOf(events).state).toBe('closed');
    expect(world.snapshot()).toEqual(initial);
    expect(world.reset()).toEqual([]);
  });
});
