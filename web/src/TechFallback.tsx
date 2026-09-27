import type { WorkOrder } from '@assetpulse/protocol';
import { useSyncExternalStore } from 'react';
import styles from './App.module.css';
import { ConnectionPill } from './ConnectionPill';
import panels from './Panels.module.css';
import type { ConsoleStore } from './store';
import { Toasts } from './Toasts';
import { activeOrders } from './world';

/**
 * Stand-in tech handheld at `/tech` until the Expo app ships (Phase 4 deletes this file). Same
 * store as the console, subscribed to `role:tech` only: work orders arrive, positions don't.
 */
export function TechFallback({ store, techId }: { store: ConsoleStore; techId: string }) {
  const { world, connection, toasts } = useSyncExternalStore(store.subscribe, store.getState);
  const live = connection.state === 'open';
  const orders = activeOrders(world);

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>AssetPulse Tech</h1>
          <p className={styles.subtitle}>
            Signed in as <code>{techId}</code>
          </p>
        </div>
        <ConnectionPill connection={connection} />
      </header>
      <section className={panels.panel} aria-labelledby="inbox-heading">
        <h2 id="inbox-heading" className={panels.heading}>
          Work orders
        </h2>
        {orders.length === 0 ? (
          <p className={panels.muted}>Nothing to restock. A PAR breach will show up here.</p>
        ) : (
          <ul className={panels.orders}>
            {orders.map((o) => (
              <OrderCard key={o.number} order={o} techId={techId} live={live} store={store} />
            ))}
          </ul>
        )}
      </section>
      <Toasts toasts={toasts} onDismiss={store.dismissToast} />
    </div>
  );
}

function OrderCard({
  order,
  techId,
  live,
  store,
}: {
  order: WorkOrder;
  techId: string;
  live: boolean;
  store: ConsoleStore;
}) {
  const mine = order.assigned_to === techId;
  const orderNumber = order.number;
  return (
    <li className={panels.order}>
      <div className={panels.orderTop}>
        <span className={panels.orderNumber}>{orderNumber}</span>
        <span className={panels.orderState}>{stateLabel(order, mine)}</span>
      </div>
      <div>{order.short_description}</div>
      <div className={panels.muted}>
        Qty {order.quantity} · {order.location}
      </div>
      <div className={panels.orderActions}>
        {order.state === 'open' && (
          <button
            type="button"
            className={styles.button}
            disabled={!live}
            onClick={() =>
              void store.run({ name: 'accept_wo', args: { orderNumber, techId } }, 'Accept')
            }
          >
            Accept
          </button>
        )}
        {mine && (
          <button
            type="button"
            className={styles.button}
            disabled={!live}
            onClick={() => void store.run({ name: 'deliver_wo', args: { orderNumber } }, 'Deliver')}
          >
            Delivered
          </button>
        )}
      </div>
    </li>
  );
}

function stateLabel(order: WorkOrder, mine: boolean): string {
  if (order.state === 'open') return 'Open';
  return mine ? 'Yours' : `Taken · ${order.assigned_to ?? '—'}`;
}
