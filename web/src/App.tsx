import { FLOOR_NAME } from '@assetpulse/protocol';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AlertRail } from './AlertRail';
import styles from './App.module.css';
import { ConnectionPill } from './ConnectionPill';
import { FloorMap } from './FloorMap';
import { ParGauge } from './ParGauge';
import panels from './Panels.module.css';
import type { ConnectionView, ConsoleStore } from './store';
import { useTheme } from './theme';
import { Toasts } from './Toasts';
import { WireDrawer } from './WireDrawer';
import { activeOrders, cleanCount } from './world';

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const KILL_MS = 10_000;

function killLabel(connection: ConnectionView, now: number): string {
  if (connection.killedUntil === null) return 'Kill network 10 s';
  const left = Math.max(0, Math.ceil((connection.killedUntil - now) / 1000));
  return `Offline · back in ${left} s`;
}

function Toolbar({
  store,
  connection,
  now,
}: {
  store: ConsoleStore;
  connection: ConnectionView;
  now: number;
}) {
  const live = connection.state === 'open';
  return (
    <div className={panels.toolbar}>
      <button
        type="button"
        className={styles.button}
        disabled={!live}
        onClick={() => void store.run({ name: 'surge', args: {} }, 'Surge ICU')}
      >
        Surge ICU
      </button>
      <button
        type="button"
        className={styles.button}
        disabled={!live}
        onClick={() => void store.run({ name: 'reset', args: {} }, 'Reset')}
      >
        Reset
      </button>
      <button
        type="button"
        className={styles.button}
        disabled={connection.killedUntil !== null}
        onClick={() => store.killNetwork(KILL_MS)}
      >
        {killLabel(connection, now)}
      </button>
      <span className={panels.toolbarHint}>Drag a pump to its next zone.</span>
    </div>
  );
}

export function App({ store, hospitalId }: { store: ConsoleStore; hospitalId: string }) {
  const { world, connection, toasts } = useSyncExternalStore(store.subscribe, store.getState);
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
        <div>
          <Toolbar store={store} connection={connection} now={now} />
          <FloorMap
            assets={[...world.assets.values()]}
            positions={store.positions}
            parBreach={breach}
            onMove={(assetId, toZoneId) => void store.moveAsset(assetId, toZoneId)}
          />
        </div>
        <aside className={styles.side}>
          {par && (
            <ParGauge clean={cleanCount(world)} min={par.min} max={par.max} breach={breach} />
          )}
          <AlertRail orders={activeOrders(world)} now={now} />
        </aside>
      </main>
      <WireDrawer stats={store.client.stats} />
      <Toasts toasts={toasts} onDismiss={store.dismissToast} />
    </div>
  );
}
