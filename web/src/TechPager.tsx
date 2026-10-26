import { RESTOCK_QUANTITY } from '@assetpulse/protocol';
import { useSyncExternalStore } from 'react';
import styles from './Panels.module.css';
import { pagerStep, type Pager, type PagerStep } from './pager';

const CHIP: Record<PagerStep, string> = {
  standby: 'Standby',
  new: 'New order',
  mine: 'Accepted',
  taken: 'Accepted',
};

/** Panel 3: the tech's handheld, as a full-width bar under the rooms. */
export function TechPager({ pager, hospitalId }: { pager: Pager; hospitalId: string }) {
  const { order, connection, busy, notice } = useSyncExternalStore(pager.subscribe, pager.getState);
  const step = pagerStep(order, pager.techId);
  const disabled = busy || connection !== 'open';

  return (
    <section
      className={`${styles.panel} ${styles.pager} ${step === 'new' ? styles.pagerNew : ''}`}
      aria-labelledby="pager-heading"
    >
      <div className={styles.pagerText}>
        <div className={styles.pagerTop}>
          <h2 id="pager-heading" className={styles.heading}>
            Tech pager
          </h2>
          <span className={`${styles.chip} ${step === 'new' ? styles.chipNew : ''}`}>
            {CHIP[step]}
          </span>
        </div>
        {order && (
          <p className={styles.pagerBody}>
            <code>{order.number}</code> · {order.short_description}
            {step === 'taken' && ` · ${order.assigned_to} is on it`}
          </p>
        )}
        {notice && (
          <p className={styles.pagerNotice} role="status">
            {notice}
          </p>
        )}
        {/* A link (it navigates) styled as a button: opens the tech's handheld in a phone frame. */}
        <a
          className={styles.pagerPhone}
          href={`/tech?h=${hospitalId}`}
          target="_blank"
          rel="noreferrer"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14">
            <rect
              x="4"
              y="1.5"
              width="8"
              height="13"
              rx="1.8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <line
              x1="7"
              y1="12"
              x2="9"
              y2="12"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
          Smartphone view
          <span className={styles.srOnly}> (opens in a new tab)</span>
        </a>
      </div>
      {step === 'new' && (
        <button type="button" className={styles.action} disabled={disabled} onClick={pager.accept}>
          Accept
        </button>
      )}
      {step === 'mine' && (
        <button
          type="button"
          className={`${styles.action} ${styles.actionRestock}`}
          disabled={disabled}
          onClick={pager.complete}
        >
          Complete restock (+{RESTOCK_QUANTITY})
        </button>
      )}
    </section>
  );
}
