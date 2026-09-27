import styles from './Panels.module.css';
import type { ConnectionView } from './store';

function label({ state, rttMs, resyncing }: ConnectionView): string {
  if (state === 'open') {
    if (resyncing) return 'resyncing…';
    return rttMs === null ? 'live' : `live · ${rttMs} ms`;
  }
  if (state === 'killed') return 'offline';
  return `${state}…`;
}

/** Every figure is measured: the RTT is the last `ping` command's ack round trip. */
export function ConnectionPill({ connection }: { connection: ConnectionView }) {
  const live = connection.state === 'open' && !connection.resyncing;
  return (
    <span className={`${styles.pill} ${live ? styles.pillLive : ''}`}>
      <span className={styles.pillDot} aria-hidden="true" />
      {label(connection)}
    </span>
  );
}
