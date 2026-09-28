import {
  FrameType,
  INITIAL_ASSETS,
  PAR,
  RESTOCK_ORIGIN,
  RESTOCK_QUANTITY,
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

/** A pump's status follows the zone it sits in: on the shelf it is clean, in a room it is in use. */
const STATUS_FOR_KIND: Record<ZoneKind, AssetStatus> = { clean: 'CLEAN', room: 'IN_USE' };

const ZONE_KIND = new Map(ZONES.map((z) => [z.id, z.kind]));
const PUMP_ID = /^IVP-(\d+)$/;
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
  /** Whether the last PAR alert sent was BREACH, so each transition is announced once. */
  private breached = false;
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

  /** Moves a pump between the shelf and the rooms; its status follows the zone it lands in. */
  moveAsset(assetId: string, toZoneId: string): WorldEvent[] {
    const asset = this.requireAsset(assetId);
    const kind = ZONE_KIND.get(toZoneId);
    if (!kind) throw new WorldError('NOT_FOUND', `zone ${toZoneId}`);
    if (asset.zoneId === toZoneId) {
      throw new WorldError('INVALID_TRANSITION', `${assetId} is already in ${toZoneId}`);
    }
    return [this.transition(asset, STATUS_FOR_KIND[kind], toZoneId)];
  }

  /**
   * Restores the initial shelf and closes every active order. Pumps a restock added are dropped
   * with no event of their own, so the caller must follow up with a full resync. Order numbers
   * keep counting.
   */
  reset(): WorldEvent[] {
    const events: WorldEvent[] = this.activeOrders().map((order) => this.closeOrder(order));
    for (const initial of INITIAL_ASSETS) {
      const asset = this.requireAsset(initial.id);
      if (asset.status !== initial.status || asset.zoneId !== initial.zoneId) {
        events.push(this.transition(asset, initial.status, initial.zoneId));
      }
    }
    this.breached = false;
    const initialIds = new Set(INITIAL_ASSETS.map((a) => a.id));
    for (const id of this.assets.keys()) if (!initialIds.has(id)) this.assets.delete(id);
    return events;
  }

  acceptOrder(number: string, techId: string): WorldEvent[] {
    const order = this.requireActiveOrder(number);
    if (order.state === 'accepted') {
      throw new WorldError('ALREADY_ASSIGNED', `${number} is assigned to ${order.assigned_to}`);
    }
    order.state = 'accepted';
    order.assigned_to = techId;
    return [this.orderEvent(order)];
  }

  /** Adds the order's pumps to the shelf as new assets, closes it, and clears PAR above min. */
  deliverOrder(number: string): WorldEvent[] {
    const order = this.requireActiveOrder(number);
    if (order.state !== 'accepted') throw new WorldError('NOT_ASSIGNED', `${number} is open`);
    const events = Array.from({ length: order.quantity }, () => this.addPump());
    events.push(this.closeOrder(order));
    if (this.breached && this.cleanCount() > PAR.min) events.push(this.clearPar());
    return events;
  }

  /**
   * Runs every tick. At or below min it raises BREACH and opens the zone's single work order.
   * Back above min (a pump returned to the shelf) it clears PAR and cancels any order no tech has
   * accepted yet. An accepted order stands: the tech is committed, and delivery still tops up.
   */
  evaluatePar(): WorldEvent[] {
    const low = this.cleanCount() <= PAR.min;
    if (low && !this.breached) return this.raiseBreach();
    if (!low && this.breached) return this.recover();
    return [];
  }

  // --- internals -------------------------------------------------------------

  private raiseBreach(): WorldEvent[] {
    this.breached = true;
    const events = [this.parEvent('BREACH')];
    if (this.activeOrders().length === 0) events.push(this.orderEvent(this.openOrder()));
    return events;
  }

  private recover(): WorldEvent[] {
    const unaccepted = this.activeOrders().filter((o) => o.state === 'open');
    return [...unaccepted.map((o) => this.closeOrder(o)), this.clearPar()];
  }

  private clearPar(): WorldEvent {
    this.breached = false;
    return this.parEvent('CLEARED');
  }

  private openOrder(): WorkOrder {
    const order: WorkOrder = {
      number: orderNumber(this.woCounter++),
      state: 'open',
      short_description: `Restock IV pumps to ${PAR.zoneId} (PAR ${PAR.min}–${PAR.max})`,
      assigned_to: null,
      location: PAR.zoneId,
      priority: ORDER_PRIORITY,
      quantity: RESTOCK_QUANTITY,
      opened_at: this.now(),
    };
    this.orders.set(order.number, order);
    return order;
  }

  private transition(asset: Asset, status: AssetStatus, zoneId: string): WorldEvent {
    const from = asset.zoneId;
    asset.status = status;
    asset.zoneId = zoneId;
    return { type: FrameType.assetChanged, assetId: asset.id, from, to: zoneId, status };
  }

  /** A new clean pump on the shelf, numbered one past the highest pump on the floor. */
  private addPump(): WorldEvent {
    const numbers = [...this.assets.keys()].map((id) => Number(PUMP_ID.exec(id)?.[1] ?? 0));
    const id = `IVP-${Math.max(0, ...numbers) + 1}`;
    const asset: Asset = { id, status: 'CLEAN', zoneId: PAR.zoneId };
    this.assets.set(id, asset);
    return {
      type: FrameType.assetChanged,
      assetId: id,
      from: RESTOCK_ORIGIN,
      to: PAR.zoneId,
      status: 'CLEAN',
    };
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
    return { zoneId, clean, min, max, state: clean <= min ? 'BREACH' : 'OK' };
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
