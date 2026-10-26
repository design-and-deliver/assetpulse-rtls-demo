import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from 'react';
import appStyles from './App.module.css';
import styles from './Panels.module.css';

/** Mirrors `AskResult` in server/src/snowflake/insights.ts. */
interface AskResult {
  text: string;
  sql: string | null;
  columns: string[];
  rows: (string | null)[][];
  suggestions: string[];
  refused?: string;
  failed?: string;
}

/** Mirrors `ShiftMetrics` in server/src/snowflake/insights.ts. */
interface ShiftMetrics {
  ordersOpened: number;
  ordersDelivered: number;
  medianMinutesToDeliver: number | null;
  medianMinutesToAccept: number | null;
  parBreaches: number;
  pumpMoves: number;
  events: number;
}

/** The `glance` route's body: the metrics plus which run they describe (null: no floor running). */
interface Glance extends ShiftMetrics {
  session: string | null;
}

/** Demo shifts are short, so under a minute reads in seconds. */
function duration(minutes: number | null): string {
  if (minutes === null) return '—';
  return minutes < 1 ? `${Math.round(minutes * 60)} s` : `${minutes.toFixed(1)} min`;
}

/**
 * The cards' numbers, fetched on every open: plain SQL, no Cortex. `failed` lets the dialog
 * fall back to the tabs alone, since the cards are a bonus and Ask may still work.
 */
function useGlance(hospitalId: string, opens: number) {
  const [glance, setGlance] = useState<Glance | null>(null);
  const [failed, setFailed] = useState(false);
  const [checks, setChecks] = useState(0);
  useEffect(() => {
    if (opens === 0) return;
    api<Glance>(`/api/insights/glance?h=${encodeURIComponent(hospitalId)}`)
      .then((g) => {
        setGlance(g);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [hospitalId, opens, checks]);
  return { glance, failed, check: () => setChecks((n) => n + 1) };
}

/** The three numbers a charge nurse or supply tech checks first, above both tabs. */
function GlanceCards({ metrics }: { metrics: ShiftMetrics }) {
  // Response time first: how long the floor waited for a tech to pick up the page.
  const cards: [string, string][] = [
    ['Median time to accept', duration(metrics.medianMinutesToAccept)],
    ['Median delivery', duration(metrics.medianMinutesToDeliver)],
    ['Orders delivered', String(metrics.ordersDelivered)],
  ];
  return (
    <section className={styles.glance} aria-labelledby="glance-h">
      <h3 id="glance-h" className={styles.glanceHeading}>
        This session
      </h3>
      <dl className={styles.shiftStats}>
        {cards.map(([label, value]) => (
          <div key={label} className={styles.shiftStat}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * The floor has activity (the button checks before opening) but Snowflake has none yet: events
 * reach it in 5 s batches, so a quick open lands in that gap.
 */
function NothingYet({ onCheck }: { onCheck: () => void }) {
  return (
    <div className={styles.insightsEmpty}>
      <p>Check again in a few seconds: your latest moves are still on their way to Snowflake.</p>
      <p className={styles.insightsFoot}>
        <button type="button" className={styles.button} onClick={onCheck}>
          Check again
        </button>
      </p>
    </div>
  );
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const TIMESTAMP_FORMAT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
};

/**
 * Timestamps (ISO from the server) read as local time. SQL returns numbers as strings with many
 * decimals ("0.066666667"); show at most two.
 */
function formatCell(cell: string): string {
  if (ISO_TIMESTAMP.test(cell)) return new Date(cell).toLocaleString(undefined, TIMESTAMP_FORMAT);
  const n = Number(cell);
  return cell.trim() !== '' && Number.isFinite(n)
    ? n.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : cell;
}

/** Events reach Snowflake in 5 s batches, so a fresh hospital has nothing to report at first. */
const NO_ACTIVITY =
  'No activity yet. Drag pumps into patient rooms, then try again in a few seconds.';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A quick second click lands inside the server's per-hospital cooldown (429). That is pacing,
 * not a failure, so wait it out once and retry instead of showing an error.
 */
async function api<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json()) as T & { error?: string; retryAfterMs?: number };
  if (res.status === 429 && !retried && body.retryAfterMs) {
    await sleep(body.retryAfterMs + 100);
    return api<T>(path, init, true);
  }
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

/** Off unless the server says Snowflake is on, so the production console is unchanged. */
function useEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    api<{ enabled: boolean }>('/api/insights/status')
      .then((s) => setEnabled(s.enabled))
      .catch(() => setEnabled(false));
  }, []);
  return enabled;
}

/** SQL column names (MEDIAN_MINUTES) as words, so a screen reader doesn't spell out underscores. */
function columnLabel(column: string): string {
  const words = column.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function ResultTable({ columns, rows }: Pick<AskResult, 'columns' | 'rows'>) {
  if (columns.length === 0) return null;
  // A wide result scrolls sideways, so the wrapper takes focus for keyboard scrolling.
  return (
    <div className={styles.insightsTableWrap} tabIndex={0} role="region" aria-label="Query results">
      <table className={styles.insightsTable}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col">
                {columnLabel(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>
                  {cell !== null ? (
                    formatCell(cell)
                  ) : (
                    <>
                      <span aria-hidden="true">—</span>
                      <span className={styles.srOnly}>none</span>
                    </>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A one-cell result (a count, a median) reads best as one large figure, not a 1x1 table. */
function Figure({ label, value }: { label: string; value: string | null }) {
  return (
    <p className={styles.insightsFigure}>
      <span className={styles.insightsFigureLabel}>{columnLabel(label)}</span>
      <span className={styles.insightsFigureValue}>{value === null ? '—' : formatCell(value)}</span>
    </p>
  );
}

function Result({ columns, rows }: Pick<AskResult, 'columns' | 'rows'>) {
  if (columns.length === 0) return null;
  if (rows.length === 0) return <p className={styles.muted}>{NO_ACTIVITY}</p>;
  if (columns.length === 1 && rows.length === 1) {
    return <Figure label={columns[0]!} value={rows[0]![0] ?? null} />;
  }
  return <ResultTable columns={columns} rows={rows} />;
}

/**
 * The result leads. Cortex's restatement of the question and its SQL sit behind one disclosure,
 * unless there is no SQL: then the text is Cortex's whole reply (e.g. asking to clarify).
 */
function Answer({ result }: { result: AskResult }) {
  return (
    <div className={styles.insightsAnswer}>
      {!result.sql && result.text && <p>{result.text}</p>}
      {result.refused && <p className={styles.muted}>Not run: {result.refused}</p>}
      {result.failed && <p className={styles.muted}>{result.failed}</p>}
      <Result columns={result.columns} rows={result.rows} />
      {result.sql && (
        <details className={styles.insightsHow}>
          <summary>How Cortex answered</summary>
          {result.text && <p>{result.text}</p>}
          <pre className={styles.insightsSql}>{result.sql}</pre>
        </details>
      )}
    </div>
  );
}

function AskPanel({
  busy,
  error,
  answer,
  onAsk,
}: {
  busy: boolean;
  error: string | null;
  answer: AskResult | null;
  onAsk: (q: string) => void;
}) {
  const [question, setQuestion] = useState('');
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (question.trim()) onAsk(question.trim());
  };
  return (
    <>
      <form className={styles.insightsForm} onSubmit={onSubmit}>
        <label htmlFor="insights-q" className={styles.srOnly}>
          Question about this hospital’s history
        </label>
        <input
          id="insights-q"
          className={styles.insightsInput}
          value={question}
          maxLength={300}
          placeholder="e.g. How many pumps were delivered?"
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button
          type="submit"
          className={`${styles.button} ${styles.insightsPrimary}`}
          disabled={!question.trim()}
          aria-disabled={busy || undefined}
        >
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </form>
      <div aria-live="polite">
        {busy && <p className={styles.srOnly}>Asking Snowflake…</p>}
        {error && <p className={styles.insightsError}>{error}</p>}
        {answer && <Answer result={answer} />}
      </div>
    </>
  );
}

/** The session's numbers, then one question at a time: only the latest answer shows. */
function InsightsBody({ hospitalId, opens }: { hospitalId: string; opens: number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<AskResult | null>(null);

  const { glance, failed, check } = useGlance(hospitalId, opens);

  // A reset starts a new session: the last run's answer no longer describes this floor.
  const session = glance?.session;
  useEffect(() => {
    setAnswer(null);
    setError(null);
  }, [session]);

  /**
   * The busy button uses aria-disabled, not disabled: disabling the focused button would drop a
   * keyboard user's focus out of it. A click while busy is ignored here instead.
   */
  async function ask(question: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setAnswer(
        await api<AskResult>(`/api/insights/ask?h=${encodeURIComponent(hospitalId)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question }),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!glance && !failed) {
    return (
      <div className={styles.insightsBody}>
        <p className={styles.muted}>Loading…</p>
      </div>
    );
  }
  if (glance && glance.events === 0) {
    return (
      <div className={styles.insightsBody}>
        <NothingYet onCheck={check} />
      </div>
    );
  }
  return (
    <div className={styles.insightsBody}>
      {glance && <GlanceCards metrics={glance} />}
      <AskPanel busy={busy} error={error} answer={answer} onAsk={(q) => void ask(q)} />
    </div>
  );
}

/** Shown under the button instead of opening, while this session has nothing to analyze. */
const HINT = 'Move a few pumps on the floor first to give Insights something to analyze.';
const HINT_MS = 5_000;

/**
 * Progressive disclosure: a header button (only when the server has Snowflake on) opens the
 * panel as a modal <dialog>, which brings Esc-to-close, a focus trap, and a backdrop. The body
 * stays mounted while closed, so the last answer is still there when it reopens.
 */
export function Insights({ hospitalId, active }: { hospitalId: string; active: boolean }) {
  const enabled = useEnabled();
  const [hint, setHint] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  /** The hint leaves on activity, after a few seconds, on a click anywhere else, or on Escape. */
  useEffect(() => {
    if (!hint) return;
    if (active) return setHint(false);
    const hide = () => setHint(false);
    const timer = setTimeout(hide, HINT_MS);
    // A click on the button itself re-shows the hint rather than toggling it off and on.
    const onPointer = (e: PointerEvent) => {
      if (!anchor.current?.contains(e.target as Node)) hide();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [hint, active]);
  const dialog = useRef<HTMLDialogElement>(null);
  /** Counts opens, so the cards refresh each time without loading while the dialog is closed. */
  const [opens, setOpens] = useState(0);
  if (!enabled) return null;
  const close = () => dialog.current?.close();
  /** showModal() would focus the first control (×); start on the question box instead. */
  const open = () => {
    if (!active) return setHint(true);
    dialog.current?.showModal();
    dialog.current?.querySelector('input')?.focus();
    setOpens((n) => n + 1);
  };
  /** A click on the backdrop lands on the <dialog> itself; clicks inside land on its children. */
  const onBackdrop = (e: MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) close();
  };

  return (
    <>
      <span ref={anchor} className={styles.insightsAnchor}>
        <button type="button" className={appStyles.button} aria-haspopup="dialog" onClick={open}>
          <span aria-hidden="true" className={styles.insightsGlyph}>
            &#10022;
          </span>{' '}
          Insights
        </button>
        {/* Always rendered, so screen readers announce the hint when it appears. */}
        <span role="status" className={styles.insightsHint}>
          {hint ? HINT : ''}
        </span>
      </span>
      <dialog
        ref={dialog}
        className={styles.insightsDialog}
        aria-labelledby="insights-h"
        onClick={onBackdrop}
      >
        <div className={styles.insightsDialogHead}>
          <p className={styles.insightsKicker}>Snowflake Cortex</p>
          <h2 id="insights-h" className={styles.insightsTitle}>
            Insights
          </h2>
          <button type="button" className={styles.insightsClose} aria-label="Close" onClick={close}>
            &times;
          </button>
        </div>
        <InsightsBody hospitalId={hospitalId} opens={opens} />
      </dialog>
    </>
  );
}
