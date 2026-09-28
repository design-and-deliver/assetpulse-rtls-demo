import { FrameType, PAR, RESTOCK_ORIGIN, RESTOCK_QUANTITY } from '@assetpulse/protocol';
import { describe, expect, it } from 'vitest';
import { World, WorldError, type WorldEvent } from '../src/world/world.js';

const T0 = 1_760_000_000_000;

function newWorld(): World {
  return new World({ now: () => T0 });
}

/** Three pumps to bedside: 2 clean, at PAR min 2. */
function breach(world: World): void {
  world.moveAsset('IVP-101', 'ICU-301');
  world.moveAsset('IVP-102', 'ICU-302');
  world.moveAsset('IVP-103', 'WARD-303');
}

/** Breach, open the order, and accept it; returns its number. */
function acceptedOrder(world: World): string {
  breach(world);
  const number = orderOf(world.evaluatePar()).number;
  world.acceptOrder(number, 'tech-1');
  return number;
}

function orderOf(events: WorldEvent[]) {
  const e = events.find((ev) => ev.type === FrameType.workOrder);
  if (!e || e.type !== FrameType.workOrder) throw new Error('no work_order event');
  return e.order;
}

function parAlerts(events: WorldEvent[]): string[] {
  return events.flatMap((e) => (e.type === FrameType.parAlert ? [e.state] : []));
}

function movedIds(events: WorldEvent[]): string[] {
  return events.flatMap((e) => (e.type === FrameType.assetChanged ? [e.assetId] : []));
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

describe('World moves', () => {
  it('puts a shelf pump in use in a room, and cleans it back on the shelf', () => {
    const world = newWorld();
    expect(world.moveAsset('IVP-101', 'ICU-301')).toEqual([
      {
        type: FrameType.assetChanged,
        assetId: 'IVP-101',
        from: 'CLEAN-UTIL',
        to: 'ICU-301',
        status: 'IN_USE',
      },
    ]);
    expect(world.moveAsset('IVP-101', 'CLEAN-UTIL')).toEqual([
      {
        type: FrameType.assetChanged,
        assetId: 'IVP-101',
        from: 'ICU-301',
        to: 'CLEAN-UTIL',
        status: 'CLEAN',
      },
    ]);
  });

  it('moves a pump room to room, still in use', () => {
    const world = newWorld();
    world.moveAsset('IVP-101', 'ICU-301');
    world.moveAsset('IVP-101', 'WARD-304');
    expect(statusOf(world, 'IVP-101')).toEqual({
      id: 'IVP-101',
      status: 'IN_USE',
      zoneId: 'WARD-304',
    });
  });

  it('rejects a move to the zone the pump is already in, and leaves it untouched', () => {
    const world = newWorld();
    expect(codeOf(() => world.moveAsset('IVP-101', 'CLEAN-UTIL'))).toBe('INVALID_TRANSITION');
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
  it('stays quiet while the clean shelf is above min', () => {
    const world = newWorld();
    world.moveAsset('IVP-101', 'ICU-301');
    world.moveAsset('IVP-102', 'ICU-302');
    expect(world.snapshot().par).toMatchObject({ clean: 3, state: 'OK' });
    expect(world.evaluatePar()).toEqual([]);
  });

  it('opens exactly one work order once the shelf reaches min', () => {
    const world = newWorld();
    breach(world);
    expect(world.snapshot().par).toMatchObject({ clean: PAR.min, state: 'BREACH' });
    const events = world.evaluatePar();
    expect(parAlerts(events)).toEqual(['BREACH']);
    expect(orderOf(events)).toEqual({
      number: 'WO0010001',
      state: 'open',
      short_description: expect.any(String),
      assigned_to: null,
      location: PAR.zoneId,
      priority: 2,
      quantity: RESTOCK_QUANTITY,
      opened_at: T0,
    });
    expect(world.snapshot().workOrders).toHaveLength(1);
  });

  it('does not open a duplicate while one is active', () => {
    const world = newWorld();
    breach(world);
    world.evaluatePar();
    world.moveAsset('IVP-104', 'WARD-304'); // shelf drops further while the order is open
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
      quantity: RESTOCK_QUANTITY,
    });
    expect(codeOf(() => world.acceptOrder(number, 'tech-2'))).toBe('ALREADY_ASSIGNED');
  });

  it('refuses delivery before accept', () => {
    const world = newWorld();
    breach(world);
    const number = orderOf(world.evaluatePar()).number;
    expect(codeOf(() => world.deliverOrder(number))).toBe('NOT_ASSIGNED');
  });

  it('restocks 3 new clean pumps, closes the order, and clears PAR', () => {
    const world = newWorld();
    const number = acceptedOrder(world);

    const events = world.deliverOrder(number);
    expect(events.filter((e) => e.type === FrameType.assetChanged)).toEqual(
      ['IVP-106', 'IVP-107', 'IVP-108'].map((assetId) => ({
        type: FrameType.assetChanged,
        assetId,
        from: RESTOCK_ORIGIN,
        to: PAR.zoneId,
        status: 'CLEAN',
      })),
    );
    expect(orderOf(events)).toMatchObject({ number, state: 'closed' });
    expect(parAlerts(events)).toEqual(['CLEARED']);
    expect(world.snapshot().par).toMatchObject({
      clean: PAR.min + RESTOCK_QUANTITY,
      state: 'OK',
    });
    expect(world.snapshot().workOrders).toEqual([]);
  });

  it('clears PAR and cancels an open order when a pump returns to the shelf', () => {
    const world = newWorld();
    breach(world);
    const number = orderOf(world.evaluatePar()).number;
    world.moveAsset('IVP-103', PAR.zoneId);

    const events = world.evaluatePar();
    expect(orderOf(events)).toMatchObject({ number, state: 'closed' });
    expect(parAlerts(events)).toEqual(['CLEARED']);
    expect(world.snapshot().workOrders).toEqual([]);
    expect(world.snapshot().par.state).toBe('OK');
    expect(world.evaluatePar()).toEqual([]);
  });

  it('keeps an accepted order when the shelf recovers, and clears PAR only once', () => {
    const world = newWorld();
    const number = acceptedOrder(world);
    world.moveAsset('IVP-103', PAR.zoneId);

    const events = world.evaluatePar();
    expect(events.filter((e) => e.type === FrameType.workOrder)).toEqual([]);
    expect(parAlerts(events)).toEqual(['CLEARED']);
    expect(world.snapshot().workOrders).toMatchObject([{ number, state: 'accepted' }]);
    expect(parAlerts(world.deliverOrder(number))).toEqual([]);
  });

  it('re-raises BREACH without a duplicate order if the shelf drops again', () => {
    const world = newWorld();
    acceptedOrder(world);
    world.moveAsset('IVP-103', PAR.zoneId);
    world.evaluatePar();
    world.moveAsset('IVP-103', 'WARD-303');

    const events = world.evaluatePar();
    expect(parAlerts(events)).toEqual(['BREACH']);
    expect(events.filter((e) => e.type === FrameType.workOrder)).toEqual([]);
  });

  it('numbers new pumps past the highest one on the floor', () => {
    const world = newWorld();
    world.deliverOrder(acceptedOrder(world));
    for (const id of ['IVP-104', 'IVP-105', 'IVP-106']) world.moveAsset(id, 'ICU-301');
    const next = orderOf(world.evaluatePar()).number;
    world.acceptOrder(next, 'tech-1');
    expect(movedIds(world.deliverOrder(next))).toEqual(['IVP-109', 'IVP-110', 'IVP-111']);
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
  it('closes an active order and restores the initial shelf', () => {
    const world = newWorld();
    const initial = world.snapshot();
    breach(world);
    world.evaluatePar();

    const events = world.reset();
    expect(orderOf(events).state).toBe('closed');
    expect(movedIds(events)).toEqual(['IVP-101', 'IVP-102', 'IVP-103']);
    expect(world.snapshot()).toEqual(initial);
    expect(world.reset()).toEqual([]);
  });

  it('drops pumps a restock added, with no event for them', () => {
    const world = newWorld();
    const initial = world.snapshot();
    world.deliverOrder(acceptedOrder(world));
    world.moveAsset('IVP-106', 'ICU-301');

    expect(movedIds(world.reset())).toEqual(['IVP-101', 'IVP-102', 'IVP-103']);
    expect(world.snapshot()).toEqual(initial);
  });
});
