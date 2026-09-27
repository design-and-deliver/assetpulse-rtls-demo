import {
  FrameType,
  INITIAL_ASSETS,
  PAR,
  SURGE_SIZE,
  ZONES,
  type Asset,
  type AssetStatus,
  type ErrorCode,
  type ParState,
  type SequencedEvent,
  type Snapshot,
  type WorkOrder,
  type ZoneKind,
} from '@assetpulse/protocol';

/**
 * A sequenced event before the event log stamps it: no envelope (`v`, `ts`) and no `seq`.
 * The log (1.5) assigns `seq` on append, so the World never owns the counter.
 */
type Unstamped<E> = E extends unknown ? Omit<E, 'v' | 'ts' | 'seq'> : never;
export type WorldEvent = Unstamped<SequencedEvent>;

export class WorldError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorldError';
  }
}

export interface WorldOptions {
  /** Clock for `opened_at`. Injected so the World stays pure and testable. */
  now?: () => number;
}

/** The one status a move may advance to, and the zone kind that status lives in. */
const NEXT_STATUS: Partial<Record<AssetStatus, AssetStatus>> = {
  CLEAN: 'IN_USE',
  IN_USE: 'SOILED',
  SOILED: 'REPROCESSING',
  REPROCESSING: 'READY',
};
const STATUS_ZONE_KIND: Record<AssetStatus, ZoneKind> = {
  CLEAN: 'clean',
  IN_USE: 'room',
  SOILED: 'soiled',
  REPROCESSING: 'spd',
  READY: 'spd',
};

const ZONE_KIND = new Map(ZONES.map((z) => [z.id, z.kind]));
const ICU_ROOMS = ZONES.filter((z) => z.id.startsWith('ICU-')).map((z) => z.id);
const FIRST_ORDER = 10_001;
const ORDER_PRIORITY = 2;

function orderNumber(n: number): string {
  return `WO${String(n).padStart(7, '0')}`;
}

/**
 * Server-authoritative state for one hospital. Every method returns the events its change
 * produced and never emits them itself; illegal requests throw a `WorldError`.
 */
export class World {
  private readonly assets: Map<string, Asset>;
  private readonly orders = new Map<string, WorkOrder>();
  private woCounter = FIRST_ORDER;
  private readonly now: () => number;

  constructor(options: WorldOptions = {}) {
    this.now = options.now ?? Date.now;
    this.assets = new Map(INITIAL_ASSETS.map((a) => [a.id, { ...a }]));
  }

  snapshot(): Snapshot {
    return {
      assets: [...this.assets.values()].map((a) => ({ ...a })),
      workOrders: this.activeOrders().map((o) => ({ ...o })),
      par: this.parState(),
    };
  }

  /** Advances an asset one lifecycle step by moving it into a zone that fits the next status. */
  moveAsset(assetId: string, toZoneId: string): WorldEvent[] {
    const asset = this.requireAsset(assetId);
    const kind = ZONE_KIND.get(toZoneId);
    if (!kind) throw new WorldError('NOT_FOUND', `zone ${toZoneId}`);
    const next = NEXT_STATUS[asset.status];
    if (!next || STATUS_ZONE_KIND[next] !== kind) {
      throw new WorldError('INVALID_TRANSITION', `${assetId}: ${asset.status} → ${toZoneId}`);
    }
    return [this.transition(asset, next, toZoneId)];
  }

  /** Pulls up to SURGE_SIZE clean pumps into the ICU rooms, round-robin. */
  surge(): WorldEvent[] {
    const clean = this.assetsIn('CLEAN').slice(0, SURGE_SIZE);
    return clean.map((asset, i) =>
      this.transition(asset, 'IN_USE', ICU_ROOMS[i % ICU_ROOMS.length] as string),
    );
  }

  /** Restores the initial floor and closes every active order. Order numbers keep counting. */
  reset(): WorldEvent[] {
    const events: WorldEvent[] = this.activeOrders().map((order) => this.closeOrder(order));
    for (const initial of INITIAL_ASSETS) {
      const asset = this.requireAsset(initial.id);
      if (asset.status !== initial.status || asset.zoneId !== initial.zoneId) {
        events.push(this.transition(asset, initial.status, initial.zoneId));
      }
    }
    return events;
  }

  acceptOrder(number: string, techId: string): WorldEvent[] {
    const order = this.requireActiveOrder(number);
    if (order.state === 'accepted') {
      throw new WorldError('ALREADY_ASSIGNED', `${number} is assigned to ${order.assigned_to}`);
    }
    order.state = 'accepted';
    order.assigned_to = techId;
    order.quantity = PAR.max - this.cleanCount();
    return [this.orderEvent(order)];
  }

  /**
   * Moves min(quantity, READY) pumps to the clean shelf and closes the order. Emits CLEARED
   * only when the shelf is back at or above min; otherwise the next evaluatePar reopens.
   */
  deliverOrder(number: string): WorldEvent[] {
    const order = this.requireActiveOrder(number);
    if (order.state !== 'accepted') throw new WorldError('NOT_ASSIGNED', `${number} is open`);
    const ready = this.assetsIn('READY');
    if (ready.length === 0) throw new WorldError('NOTHING_READY', `no READY pumps for ${number}`);

    const events = ready
      .slice(0, order.quantity)
      .map((asset) => this.transition(asset, 'CLEAN', PAR.zoneId));
    events.push(this.closeOrder(order));
    if (this.cleanCount() >= PAR.min) events.push(this.parEvent('CLEARED'));
    return events;
  }

  /** Opens the zone's single work order when the clean shelf is below min. */
  evaluatePar(): WorldEvent[] {
    if (this.cleanCount() >= PAR.min || this.activeOrders().length > 0) return [];
    const order: WorkOrder = {
      number: orderNumber(this.woCounter++),
      state: 'open',
      short_description: `Restock IV pumps to ${PAR.zoneId} (PAR ${PAR.min}–${PAR.max})`,
      assigned_to: null,
      location: PAR.zoneId,
      priority: ORDER_PRIORITY,
      quantity: PAR.max - this.cleanCount(),
      opened_at: this.now(),
    };
    this.orders.set(order.number, order);
    return [this.parEvent('BREACH'), this.orderEvent(order)];
  }

  // --- internals -------------------------------------------------------------

  private transition(asset: Asset, status: AssetStatus, zoneId: string): WorldEvent {
    const from = asset.zoneId;
    asset.status = status;
    asset.zoneId = zoneId;
    return { type: FrameType.assetChanged, assetId: asset.id, from, to: zoneId, status };
  }

  private closeOrder(order: WorkOrder): WorldEvent {
    order.state = 'closed';
    this.orders.delete(order.number);
    return this.orderEvent(order);
  }

  private orderEvent(order: WorkOrder): WorldEvent {
    return { type: FrameType.workOrder, order: { ...order } };
  }

  private parEvent(state: 'BREACH' | 'CLEARED'): WorldEvent {
    const { zoneId, min, max } = PAR;
    return { type: FrameType.parAlert, zoneId, state, clean: this.cleanCount(), min, max };
  }

  private parState(): ParState {
    const clean = this.cleanCount();
    const { zoneId, min, max } = PAR;
    return { zoneId, clean, min, max, state: clean < min ? 'BREACH' : 'OK' };
  }

  private requireAsset(assetId: string): Asset {
    const asset = this.assets.get(assetId);
    if (!asset) throw new WorldError('NOT_FOUND', `asset ${assetId}`);
    return asset;
  }

  /** Closed orders are dropped from the map, so a closed number reads as NOT_FOUND. */
  private requireActiveOrder(number: string): WorkOrder {
    const order = this.orders.get(number);
    if (!order) throw new WorldError('NOT_FOUND', `work order ${number}`);
    return order;
  }

  private activeOrders(): WorkOrder[] {
    return [...this.orders.values()];
  }

  private assetsIn(status: AssetStatus): Asset[] {
    return [...this.assets.values()].filter((a) => a.status === status);
  }

  private cleanCount(): number {
    return this.assetsIn('CLEAN').length;
  }
}
