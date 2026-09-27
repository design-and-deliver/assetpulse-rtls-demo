import type { WorkOrder } from '@assetpulse/protocol';
import styles from './Panels.module.css';

function age(openedAt: number, now: number): string {
  const s = Math.max(0, Math.round((now - openedAt) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

export function AlertRail({ orders, now }: { orders: WorkOrder[]; now: number }) {
  return (
    <section className={styles.panel} aria-labelledby="orders-heading">
      <h2 id="orders-heading" className={styles.heading}>
        Work orders
      </h2>
      {orders.length === 0 ? (
        <p className={styles.muted}>None open</p>
      ) : (
        <ul className={styles.orders}>
          {orders.map((o) => (
            <li key={o.number} className={styles.order}>
              <div className={styles.orderTop}>
                <span className={styles.orderNumber}>{o.number}</span>
                <span className={styles.orderState}>
                  {o.state === 'open' ? 'Open' : `Accepted · ${o.assigned_to ?? '—'}`}
                </span>
              </div>
              <div>{o.short_description}</div>
              <div className={styles.muted}>
                Qty {o.quantity} · {o.location} · {age(o.opened_at, now)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
