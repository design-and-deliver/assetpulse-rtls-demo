import { INITIAL_ASSETS, PAR } from '@assetpulse/protocol';
import { useSyncExternalStore } from 'react';
import styles from './App.module.css';
import { ConnectionPill } from './ConnectionPill';
import type { Pager } from './pager';
import { Stock } from './Stock';
import type { ConsoleStore } from './store';
import { TechPager } from './TechPager';
import { Toasts } from './Toasts';
import { WireDrawer } from './WireDrawer';
import { cleanCount } from './world';

/** Pumps a fresh shelf must lose to reach its minimum and page a tech. */
const TO_BREACH = INITIAL_ASSETS.length - PAR.min;

/** One column, one story: shelf → rooms → pager → the wire underneath it all. */
export function App({
  store,
  pager,
  hospitalId,
}: {
  store: ConsoleStore;
  pager: Pager;
  hospitalId: string;
}) {
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
        <Stock
          assets={[...world.assets.values()]}
          par={world.par}
          clean={cleanCount(world)}
          onMove={(assetId, toZoneId) => void store.moveAsset(assetId, toZoneId)}
        />
        <TechPager pager={pager} hospitalId={hospitalId} />
        <WireDrawer stats={store.client.stats} connection={connection} onKill={store.killNetwork} />
      </main>
      <Toasts toasts={toasts} onDismiss={store.dismissToast} />
    </div>
  );
}
