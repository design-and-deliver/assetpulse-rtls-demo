import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
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
}

/** Mirrors `ShiftSummary` in server/src/snowflake/insights.ts. */
interface ShiftSummary {
  events: number;
  metrics: {
    ordersOpened: number;
    ordersDelivered: number;
    medianMinutesToDeliver: number | null;
    parBreaches: number;
    pumpMoves: number;
  };
  summary: string;
}

/** Demo shifts are short, so under a minute reads in seconds. */
function duration(minutes: number | null): string {
  if (minutes === null) return '—';
  return minutes < 1 ? `${Math.round(minutes * 60)} s` : `${minutes.toFixed(1)} min`;
}

/** Numbers first (measured in SQL), then the AI's prose, so the facts never depend on the model. */
function Summary({ data }: { data: ShiftSummary }) {
  if (data.events === 0) {
    return <p className={styles.insightsAnswer}>No events in the last 12 hours yet.</p>;
  }
  const m = data.metrics;
  const stats: [string, string][] = [
    ['Orders opened', String(m.ordersOpened)],
    ['Orders delivered', String(m.ordersDelivered)],
    ['Median page to delivery', duration(m.medianMinutesToDeliver)],
    ['Shelf hit minimum', String(m.parBreaches)],
    ['Pump moves', String(m.pumpMoves)],
  ];
  return (
    <section className={styles.shift} aria-labelledby="shift-h">
      <h3 id="shift-h" className={styles.shiftHeading}>
        Last 12 hours
      </h3>
      <dl className={styles.shiftStats}>
        {stats.map(([label, value]) => (
          <div key={label} className={styles.shiftStat}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {data.summary && (
        <>
          <h4 className={styles.shiftSub}>What happened</h4>
          <p className={styles.shiftProse}>{data.summary}</p>
          <p className={styles.shiftCredit}>
            Written by Cortex AI_SUMMARIZE_AGG from {data.events} events.
          </p>
        </>
      )}
    </section>
  );
}

const EXAMPLES = [
  'How many work orders were opened today?',
  'Median minutes from page to delivery, by tech',
  'How many times did the shelf drop to its minimum?',
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json()) as T & { error?: string };
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
                  {cell ?? (
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

function Answer({ result }: { result: AskResult }) {
  return (
    <div className={styles.insightsAnswer}>
      {result.text && <p>{result.text}</p>}
      {result.refused && <p className={styles.muted}>Not run: {result.refused}</p>}
      <ResultTable columns={result.columns} rows={result.rows} />
      {result.sql && (
        <details>
          <summary>SQL Cortex Analyst wrote</summary>
          <pre className={styles.insightsSql}>{result.sql}</pre>
        </details>
      )}
    </div>
  );
}

/** The overlay's contents: ask in plain English (Cortex Analyst) or get a shift summary (AI_SUMMARIZE_AGG). */
function InsightsBody({ hospitalId }: { hospitalId: string }) {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<AskResult | null>(null);
  const [summary, setSummary] = useState<ShiftSummary | null>(null);

  const h = encodeURIComponent(hospitalId);
  /**
   * Busy buttons use aria-disabled, not disabled: disabling the focused button would drop a
   * keyboard user's focus out of it. A click while busy is ignored here instead.
   */
  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  const ask = (q: string) =>
    run(async () => {
      setAnswer(
        await api<AskResult>(`/api/insights/ask?h=${h}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question: q }),
        }),
      );
    });
  const summarize = () =>
    run(async () => {
      setSummary(await api<ShiftSummary>(`/api/insights/summary?h=${h}`));
    });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (question.trim()) void ask(question.trim());
  };

  return (
    <div className={styles.insightsBody}>
      <form className={styles.insightsForm} onSubmit={onSubmit}>
        <label htmlFor="insights-q" className={styles.srOnly}>
          Question about this hospital’s history
        </label>
        <input
          id="insights-q"
          className={styles.insightsInput}
          value={question}
          maxLength={300}
          placeholder="e.g. Median minutes from page to delivery, by tech"
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
      <div className={styles.insightsChips}>
        {EXAMPLES.map((q) => (
          <button
            key={q}
            type="button"
            className={styles.insightsChip}
            aria-disabled={busy || undefined}
            onClick={() => {
              if (busy) return;
              setQuestion(q);
              void ask(q);
            }}
          >
            {q}
          </button>
        ))}
      </div>
      <div aria-live="polite">
        {busy && <p className={styles.srOnly}>Asking Snowflake…</p>}
        {error && <p className={styles.insightsError}>{error}</p>}
        {summary && <Summary data={summary} />}
        {answer && <Answer result={answer} />}
      </div>
      <p className={styles.insightsFoot}>
        <button
          type="button"
          className={styles.button}
          aria-disabled={busy || undefined}
          onClick={() => void summarize()}
        >
          Shift summary
        </button>
        <span className={styles.muted}>Events load into Snowflake every 5 s.</span>
      </p>
    </div>
  );
}

/**
 * Progressive disclosure: a header button (only when the server has Snowflake on) opens the
 * panel as a modal <dialog>, which brings Esc-to-close, a focus trap, and a backdrop. The body
 * stays mounted while closed, so the last answer is still there when it reopens.
 */
export function Insights({ hospitalId }: { hospitalId: string }) {
  const enabled = useEnabled();
  const dialog = useRef<HTMLDialogElement>(null);
  if (!enabled) return null;
  const close = () => dialog.current?.close();
  /** showModal() would focus the first control (×); start on the question box instead. */
  const open = () => {
    dialog.current?.showModal();
    dialog.current?.querySelector('input')?.focus();
  };
  /** A click on the backdrop lands on the <dialog> itself; clicks inside land on its children. */
  const onBackdrop = (e: MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) close();
  };

  return (
    <>
      <button type="button" className={appStyles.button} aria-haspopup="dialog" onClick={open}>
        <span aria-hidden="true" className={styles.insightsGlyph}>
          &#10022;
        </span>{' '}
        Insights
      </button>
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
        <InsightsBody hospitalId={hospitalId} />
      </dialog>
    </>
  );
}
