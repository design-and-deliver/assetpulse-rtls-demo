import type { AssetPulseClient, ConnectionState } from '@assetpulse/client';
import { FrameType, type Command, type WorkOrder } from '@assetpulse/protocol';
import { commandFailureText } from './copy';
import { outcome } from './store';

/** The pager's tech id on the wire — a phone joins as `tech-NNNN`, so the two never collide. */
export const PAGER_TECH_ID = 'tech-web';

/** standby → new (Accept) → mine (Complete restock) → standby; `taken` = another tech accepted. */
export type PagerStep = 'standby' | 'new' | 'mine' | 'taken';

export interface PagerState {
  order: WorkOrder | null;
  connection: ConnectionState;
  /** A command is out and its ack hasn't come back. */
  busy: boolean;
  /** Why the last command was refused; cleared by the next order update. */
  notice: string | null;
}

export interface Pager {
  readonly techId: string;
  getState(): PagerState;
  subscribe(fn: () => void): () => void;
  accept(): void;
  complete(): void;
}

/** The one order the pager shows: the newest that isn't closed. */
export function currentOrder(orders: Iterable<WorkOrder>): WorkOrder | null {
  let newest: WorkOrder | null = null;
  for (const o of orders) {
    if (o.state !== 'closed' && (!newest || o.opened_at > newest.opened_at)) newest = o;
  }
  return newest;
}

export function pagerStep(order: WorkOrder | null, techId: string): PagerStep {
  if (!order) return 'standby';
  if (order.state === 'open') return 'new';
  return order.assigned_to === techId ? 'mine' : 'taken';
}

/**
 * A second, independent client on the same hospital — subscribed as a tech, never reading the
 * console's store — so an order reaching the pager is a real fan-out, not a local callback.
 */
export function createPager(client: AssetPulseClient, techId = PAGER_TECH_ID): Pager {
  const listeners = new Set<() => void>();
  let orders = new Map<string, WorkOrder>();
  let state: PagerState = {
    order: null,
    connection: client.state$.value,
    busy: false,
    notice: null,
  };

  const update = (patch: Partial<PagerState>) => {
    state = { ...state, ...patch };
    for (const fn of listeners) fn();
  };
  const reset = (list: WorkOrder[]) => {
    orders = new Map(list.map((o) => [o.number, o]));
    update({ order: currentOrder(orders.values()), notice: null });
  };

  client.on(FrameType.hello, (f) => reset(f.snapshot.workOrders));
  client.on(FrameType.resync, (f) => reset(f.snapshot.workOrders));
  client.on(FrameType.workOrder, ({ order }) => {
    orders.set(order.number, order);
    update({ order: currentOrder(orders.values()), notice: null });
  });
  client.state$.subscribe((connection) => update({ connection }));

  async function run(command: (orderNumber: string) => Command, action: string): Promise<void> {
    const order = state.order;
    if (!order || state.busy) return;
    update({ busy: true, notice: null });
    const failure = await outcome(client, command(order.number));
    update({ busy: false, notice: failure === null ? null : commandFailureText(action, failure) });
  }

  return {
    techId,
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    accept: () =>
      void run((orderNumber) => ({ name: 'accept_wo', args: { orderNumber, techId } }), 'Accept'),
    complete: () =>
      void run((orderNumber) => ({ name: 'deliver_wo', args: { orderNumber } }), 'Restock'),
  };
}
