import styles from './Panels.module.css';
import type { ConnectionView } from './store';

function label({ state, resyncing }: ConnectionView): string {
  if (state === 'open') return resyncing ? 'resyncing…' : 'live';
  if (state === 'killed') return 'offline';
  return `${state}…`;
}

/** The console socket's state; its measured RTT sits in the wire drawer's header. */
export function ConnectionPill({ connection }: { connection: ConnectionView }) {
  const live = connection.state === 'open' && !connection.resyncing;
  return (
    <span className={`${styles.pill} ${live ? styles.pillLive : ''}`}>
      <span className={styles.pillDot} aria-hidden="true" />
      {label(connection)}
    </span>
  );
}
