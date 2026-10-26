import { INITIAL_ASSETS, PAR } from '@assetpulse/protocol';
import { useSyncExternalStore } from 'react';
import styles from './App.module.css';
import { ConnectionPill } from './ConnectionPill';
import { Insights } from './Insights';
import { PhonePanel } from './PhonePanel';
import { Stock } from './Stock';
import type { ConsoleStore } from './store';
import { Toasts } from './Toasts';
import { WireDrawer } from './WireDrawer';
import { cleanCount, sessionHasActivity } from './world';

/** Pumps a fresh shelf must lose to reach its minimum and page a tech. */
const TO_BREACH = INITIAL_ASSETS.length - PAR.min;

/** The floor (shelf → rooms → the wire underneath) beside the tech's phone. History opens on demand. */
export function App({ store, hospitalId }: { store: ConsoleStore; hospitalId: string }) {
  const { world, connection, toasts } = useSyncExternalStore(store.subscribe, store.getState);
  const live = connection.state === 'open';

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>AssetPulse</h1>
          <p className={styles.subtitle}>
            Drag {TO_BREACH} pumps into patient rooms to drop the shelf to its minimum and page a
            tech.
          </p>
        </div>
        <div className={styles.headerTools}>
          <ConnectionPill connection={connection} />
          <Insights hospitalId={hospitalId} active={sessionHasActivity(world)} />
          <button
            type="button"
            className={styles.button}
            disabled={!live}
            onClick={() => void store.run({ name: 'reset', args: {} }, 'Reset')}
          >
            Reset
          </button>
        </div>
      </header>
      <main className={styles.main}>
        <div className={styles.floor}>
          <Stock
            assets={[...world.assets.values()]}
            par={world.par}
            clean={cleanCount(world)}
            onMove={(assetId, toZoneId) => void store.moveAsset(assetId, toZoneId)}
          />
          <div className={styles.wire}>
            <WireDrawer
              stats={store.client.stats}
              connection={connection}
              onKill={store.killNetwork}
            />
          </div>
        </div>
        <div className={styles.phone}>
          <PhonePanel hospitalId={hospitalId} />
        </div>
      </main>
      <Toasts toasts={toasts} onDismiss={store.dismissToast} />
    </div>
  );
}
