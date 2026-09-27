import type { ClientStats, WireEntry } from '@assetpulse/client';
import { FrameType } from '@assetpulse/protocol';
import { useEffect, useState } from 'react';
import styles from './Panels.module.css';

const REFRESH_MS = 500;

interface Row {
  key: number;
  dir: WireEntry['dir'];
  time: string;
  type: string;
  raw: string;
}

/** Entries are stable objects in a sliding buffer, so identity is the only key that doesn't shift. */
const entryKeys = new WeakMap<WireEntry, number>();
let nextKey = 0;
function keyOf(entry: WireEntry): number {
  let key = entryKeys.get(entry);
  if (key === undefined) entryKeys.set(entry, (key = nextKey++));
  return key;
}

function clock(ts: number): string {
  const d = new Date(ts);
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${d.toLocaleTimeString([], { hour12: false })}.${ms}`;
}

/** `command · move_asset`, `ack · INVALID_TRANSITION`, or just the frame type. */
function describe(raw: string): string {
  try {
    const f = JSON.parse(raw) as { type?: string; name?: string; ok?: boolean; error?: string };
    if (f.type === FrameType.command) return `command · ${f.name}`;
    if (f.type === FrameType.ack) return f.ok ? 'ack · ok' : `ack · ${f.error}`;
    return f.type ?? '?';
  } catch {
    return 'unparseable';
  }
}

function toRows(log: WireEntry[], hidePositions: boolean): Row[] {
  const rows: Row[] = [];
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i] as WireEntry;
    const type = describe(entry.raw);
    if (hidePositions && type === FrameType.positions) continue;
    rows.push({ key: keyOf(entry), dir: entry.dir, time: clock(entry.ts), type, raw: entry.raw });
  }
  return rows;
}

/**
 * The raw frames, newest first, straight from the client's wire log. The log is a mutable ring
 * buffer, so while open the drawer re-reads it on a timer instead of subscribing.
 */
export function WireDrawer({ stats }: { stats: ClientStats }) {
  const [open, setOpen] = useState(false);
  const [hidePositions, setHidePositions] = useState(true);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, [open]);

  const rows = open ? toRows(stats.lastFrameRaw, hidePositions) : [];

  return (
    <section className={`${styles.panel} ${styles.wire}`}>
      <div className={styles.wireBar}>
        <button
          type="button"
          className={styles.wireToggle}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? '▾' : '▸'} On the wire
        </button>
        <span className={styles.muted}>
          {stats.framesIn} in · {stats.framesOut} out · {stats.reconnects} reconnects
        </span>
        {open && (
          <label className={styles.wireFilter}>
            <input
              type="checkbox"
              checked={hidePositions}
              onChange={(e) => setHidePositions(e.target.checked)}
            />
            Hide positions
          </label>
        )}
      </div>
      {open && (
        <ol className={styles.wireList}>
          {rows.map((row) => (
            <li key={row.key}>
              <details>
                <summary className={styles.wireRow}>
                  <span className={styles.wireDir} title={row.dir === 'in' ? 'received' : 'sent'}>
                    {row.dir === 'in' ? '↓' : '↑'}
                  </span>
                  <span className={styles.muted}>{row.time}</span>
                  <span>{row.type}</span>
                </summary>
                <pre className={styles.wireRaw}>{row.raw}</pre>
              </details>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
