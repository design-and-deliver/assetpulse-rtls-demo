import { FLOOR_NAME } from '@assetpulse/protocol';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AlertRail } from './AlertRail';
import styles from './App.module.css';
import { ConnectionPill } from './ConnectionPill';
import { FloorMap } from './FloorMap';
import { ParGauge } from './ParGauge';
import type { ConsoleStore } from './store';
import { useTheme } from './theme';
import { activeOrders, cleanCount } from './world';

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function App({ store, hospitalId }: { store: ConsoleStore; hospitalId: string }) {
  const { world, connection } = useSyncExternalStore(store.subscribe, store.getState);
  const [theme, toggleTheme] = useTheme();
  const now = useNow(1000);
  const par = world.par;
  const breach = par?.state === 'BREACH';

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>AssetPulse</h1>
          <p className={styles.subtitle}>
            Floor {FLOOR_NAME} · hospital <code>{hospitalId}</code>
          </p>
        </div>
        <div className={styles.headerTools}>
          <ConnectionPill connection={connection} />
          <button type="button" className={styles.button} onClick={toggleTheme}>
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
        </div>
      </header>
      <main className={styles.main}>
        <FloorMap
          assets={[...world.assets.values()]}
          positions={store.positions}
          parBreach={breach}
        />
        <aside className={styles.side}>
          {par && (
            <ParGauge clean={cleanCount(world)} min={par.min} max={par.max} breach={breach} />
          )}
          <AlertRail orders={activeOrders(world)} now={now} />
        </aside>
      </main>
    </div>
  );
}
